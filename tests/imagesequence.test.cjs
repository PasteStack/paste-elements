'use strict';

// The imagesequence element contract: a declared host owns its source —
// the authored image is the baseline, scroll progress picks the frame,
// only a still-desired load commits, failures leave the paint alone,
// and speculative preparation stays inside its bounds. The resolution
// flag sharpens the displayed frame through the shared policy.

const test = require('node:test');
const assert = require('assert/strict');
const {openUiStack, Element, FakeSubscription, settlePromises, settleAll, mediaQueryList, imageRegistry} = require('./fakes.cjs');

// Prepared and painted sources surface resolved against the fake
// document's base — the same shape a browser's src getter reports.
const url = function (src) { return 'http://localhost/' + src; };

function scriptJson(id, object) {
    const script = new Element('script', id);
    script.setAttribute('type', 'application/json');
    script.textContent = JSON.stringify(object);
    return script;
}

// The module reports every declaration it rejects — and page or
// platform code that throws inside its pass — by rethrowing it on a later task through
// the window's timer. A page under test carries a timer that keeps those
// reports instead of letting them escape the test: `reports` lists every
// error the module rethrew, in order.
function reportingWindow(extra) {
    const reports = [];
    const win = Object.assign({
        setTimeout: function (callback, delay) {
            return setTimeout(function () {
                try {
                    callback();
                } catch (error) {
                    reports.push(error);
                }
            }, delay);
        }
    }, extra || {});
    return {window: win, reports: reports};
}

// Lets every timer the module armed run, then answers the reports kept.
function reportsAfterATurn(reports) {
    return new Promise(function (resolve) {
        setTimeout(function () {
            resolve(reports.slice());
        }, 1);
    });
}

// openUiStack with a reporting timer on its window: the stack carries
// `reports`, every error the module rethrew.
function openStack(env) {
    env = env || {};
    const reporting = reportingWindow(env.window);
    const stack = openUiStack(Object.assign({}, env, {window: reporting.window}));
    stack.reports = reporting.reports;
    return stack;
}

// What an img host presents: the module's single srcset width
// descriptor when it wrote one — every sharper representation rides
// srcset — else its src. A preparation Image presents its src.
function presented(host) {
    const srcset = typeof host.getAttribute === 'function' ? host.getAttribute('srcset') : null;
    if (!srcset) return host.src;
    let node = host;
    while (node && !node.ownerDocument) node = node.parentNode;
    const base = node && node.ownerDocument ? node.ownerDocument.baseURI : 'http://localhost/';
    return new URL(srcset.split(' ')[0], base).href;
}

function catalog(count, upgrades) {
    const frames = [];
    for (let index = 0; index < count; index += 1) {
        frames.push({
            src: 'f' + index + '.jpg',
            width: 800,
            height: 450,
            upgrades: upgrades || []
        });
    }
    return {frames: frames};
}

// A scope element the declared host sits inside: subject scroll-space
// 1600..1800 against an 800-tall viewport — S=800, E=1800, one full
// scroll range of authored progress.
function declaredPage(env) {
    env = env || {};
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const host = env.host || new Element('img', 'host');
    host.setAttribute('data-paste-imagesequence', '#frames');
    // The default img host is an ordinary sized image: its authored
    // width and height pin the layout, so a frame or an upgrade paints
    // as a plain src. A test of an intrinsically sized host passes its
    // own element.
    if (!env.host) {
        host.setAttribute('width', '800');
        host.setAttribute('height', '450');
    }
    // An img host always authors a src — a src-less img host is a
    // malformed declaration. `baseline: null` means an authored poster
    // that no catalog frame matches, so nothing is adopted; a background
    // host gets no inline baseline at all.
    if (env.baseline === null) {
        if (host.tagName === 'IMG' && !host.src) {
            host.src = 'poster.jpg';
        }
    } else if (!env.noSrc) {
        host.src = env.baseline === undefined ? 'f0.jpg' : env.baseline;
    }
    if (env.resolution) {
        host.setAttribute('data-paste-progressiveresolution', '');
    }
    if (env.imageProperty) {
        host.setAttribute('data-image-property', env.imageProperty);
    }
    if (env.scrubSelector) {
        host.setAttribute('data-sequence-scrub', env.scrubSelector);
    }
    if (env.sequenceFrom !== undefined) {
        host.setAttribute('data-sequence-from', String(env.sequenceFrom));
    }
    if (env.sequenceTo !== undefined) {
        host.setAttribute('data-sequence-to', String(env.sequenceTo));
    }
    if (env.intro) {
        if (env.intro.from !== undefined) {
            host.setAttribute('data-sequence-intro-from', String(env.intro.from));
        }
        if (env.intro.to !== undefined) {
            host.setAttribute('data-sequence-intro-to', String(env.intro.to));
        }
        host.setAttribute('data-sequence-intro-duration-ms', String(env.intro.durationMs));
        if (env.intro.bufferMs !== undefined) {
            host.setAttribute('data-sequence-intro-buffer-ms', String(env.intro.bufferMs));
        }
        if (env.intro.easing) {
            host.setAttribute('data-sequence-intro-easing', env.intro.easing);
        }
        if (env.intro.skip) {
            host.setAttribute('data-sequence-intro-skip', env.intro.skip);
        }
    }
    if (env.scrubBuffer !== undefined) {
        host.setAttribute('data-sequence-scrub-buffer-frames', String(env.scrubBuffer));
    }
    if (env.scopeWindow) {
        scope.setAttribute('data-scrub-window', env.scopeWindow);
    }
    if (env.scopeStart) {
        scope.setAttribute('data-scrub-start', env.scopeStart);
    }
    if (env.scopeEnd) {
        scope.setAttribute('data-scrub-end', env.scopeEnd);
    }
    if (env.hostRect) {
        host.rect = env.hostRect;
    }
    scope.appendChild(host);
    const frames = scriptJson('frames', env.catalogDocument || catalog(4, env.upgrades));
    scope.appendChild(frames);
    if (env.scroller) {
        // A nested root scrolls itself, not the window — container mode
        // resolves the declared scroller as the range's offset source.
        scope.setAttribute('data-scrub-mode', 'container');
        scope.setAttribute('data-scrub-root', '#' + env.scroller.id);
        env.scroller.appendChild(scope);
    }
    const extra = {};
    if (env.skipElement) {
        extra.skip = env.skipElement;
        scope.appendChild(extra.skip);
    } else if (env.skipId) {
        extra.skip = new Element('button', env.skipId);
        extra.skip.setAttribute('type', 'button');
        extra.skip.setAttribute('hidden', '');
        scope.appendChild(extra.skip);
    }
    // Subject scroll-space 1600..1800 vs an 800-tall viewport:
    // S=800, E=1800 — offset 0 is progress 0, the range below the fold.
    scope.rect = env.scopeRect || {top: 1600, bottom: 1800, width: 100, height: 200};
    if (env.scopeClientRects !== undefined) {
        scope.clientRects = env.scopeClientRects;
        // An element with no client rects has an all-zero bounding box.
        if (env.scopeClientRects.length === 0) {
            scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
        }
    }
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: env.scrollscrub !== false,
        imagesequence: true,
        progressiveresolution: env.withStandaloneResolution === true,
        window: env.window,
        document: env.document,
        globals: env.globals,
        frameDriver: env.frameDriver
    });
    return {stack: stack, scope: scope, host: host, skip: extra.skip, reports: stack.reports};
}

function scrollTo(stack, scope, offset) {
    stack.window.pageYOffset = offset;
    stack.window.fireEvent('scroll');
}

// Offset 0 lands progress 0; 1300 lands 0.5 (desired frame 2 of 4);
// 1800 lands 1 (desired 3). The subject rect tracks its viewport spot.
function scrollFraction(stack, scope, offset) {
    scrollTo(stack, scope, offset);
    scope.rect = {top: 1600 - offset, bottom: 1800 - offset, width: 100, height: 200};
}

test('sequence upgrades validate decoded dimensions before claiming srcset', async () => {
    for (const sample of [
        {width: 800, height: 450, accepted: false},
        {width: 1600, height: 1600, accepted: false},
        {width: 1600, height: 900, accepted: true},
        {width: 1600, height: 901, accepted: true}
    ]) {
        for (const decode of [true, false]) {
            FakeSubscription.reset();
            const {stack, host} = declaredPage({
                resolution: true,
                window: {devicePixelRatio: 2},
                hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
                catalogDocument: {frames: [{src: 'f0.jpg', width: 800, height: 450,
                    upgrades: [{src: 'up.jpg', width: 1600, height: 900}]}]}
            });
            stack.driver.tick(16);
            const upgrade = stack.images.find(image => image.src === url('up.jpg'));
            assert.ok(upgrade, 'the sharper representation was requested');
            if (!decode) {
                delete upgrade.decode;
            }
            // A dimension mismatch is permanent even when decoding
            // completed while hidden; visibility must not retry it.
            stack.document.hidden = true;
            upgrade.succeed(sample.width, sample.height);
            await settlePromises();
            stack.document.hidden = false;
            stack.document.fireEvent('visibilitychange');
            stack.driver.tick(32);
            assert.strictEqual(presented(host), sample.accepted ? url('up.jpg') : url('f0.jpg'));
            if (!sample.accepted) {
                assert.strictEqual(host.getAttribute('srcset'), null);
                assert.strictEqual(host.getAttribute('sizes'), null);
            }
            stack.window.fireEvent('resize');
            stack.driver.tick(48);
            assert.strictEqual(stack.images.filter(image => image.src === url('up.jpg')).length, 1,
                'a settled representation is not fetched again');
        }
    }
});

test('a frame with mismatched pixels stays failed while later valid frames can paint', async () => {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({baseline: null});
    stack.driver.tick(16);
    stack.images.find(image => image.src === url('f0.jpg')).succeed(400, 225);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('poster.jpg'));

    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    stack.images.find(image => image.src === url('f2.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'));

    scrollFraction(stack, scope, 0);
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'));
    assert.strictEqual(stack.images.filter(image => image.src === url('f0.jpg')).length, 1);
});

function baselineAdoptsThenNeighborsPrepare() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline stands');
    // progress 0 → desired 0 = displayed 0: the adopted rep's own
    // decode proof is demanded first — a complete img is a settled
    // request, not proven pixels — then the forward lookahead
    // speculates the rest of the declared range, nearest first.
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg'), url('f1.jpg'), url('f2.jpg'), url('f3.jpg')],
        'the baseline proves itself, then the lookahead prepares ahead');
}

async function scrollCommitsTheDesiredFrame() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    stack.images[0].succeed(800, 450); // f1 ready
    await settlePromises();

    scrollFraction(stack, scope, 1300); // progress 0.5 → frame 2
    stack.driver.tick(32);
    const started = stack.images.map(function (image) { return image.src; });
    assert.ok(started.indexOf(url('f2.jpg')) >= 0, 'the desired frame is prepared');
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    // The completion marks the sequence dirty — the paint lands in the
    // scheduled pass, never inside another sequence's read phase.
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'a still-desired load commits');
}

async function outOfOrderCompletionCommitsTheCurrentDesire() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({baseline: null});
    stack.driver.tick(16);
    // No adoption: frame 0 itself is fetching.
    const first = stack.images[0];
    assert.strictEqual(presented(first), url('f0.jpg'));

    scrollFraction(stack, scope, 1300); // desire moves to 2 before f0 lands
    stack.driver.tick(32);
    // f0's reprioritization does not stop its physical request — it
    // keeps its slot until it settles, so f2 starts when f0 reports.
    first.succeed(800, 450); // the stale frame lands first
    await settlePromises();
    stack.driver.tick(48); // the freed slot's re-admission is the pass's work
    assert.notStrictEqual(presented(host), url('f0.jpg'), 'a stale completion paints nothing');
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(f2, 'the new desire started once its slot freed');
    f2.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the current desire wins');
}

async function failedFrameLeavesThePaint() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // desire 2
    stack.driver.tick(32);
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.succeed(800, 450);
        } else {
            image.fail();
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'));
    // Scroll back onto the failed frame — the paint does not regress
    // to a broken request.
    scrollFraction(stack, scope, 1150); // progress 0.35 → desire 1
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'a failed or unprepared frame never downgrades the paint');
}

async function preparationStaysBounded() {
    FakeSubscription.reset();
    const frames = [];
    for (let index = 0; index < 40; index += 1) {
        frames.push({src: 'long-' + index + '.jpg', width: 800, height: 450});
    }
    const {stack, scope, host} = declaredPage({
        baseline: null,
        catalogDocument: {frames: frames}
    });
    let clock = 16;
    const landed = new Set();
    const succeedAll = async function () {
        // Each settle marks dirty — the freed slot's next admission is
        // the scheduled pass's work, so a round needs a frame to land
        // whatever the pass just started.
        for (let round = 0; round < 4; round += 1) {
            stack.images.forEach(function (image) {
                if (!landed.has(image)) {
                    landed.add(image);
                    image.succeed(800, 450);
                }
            });
            await settlePromises();
            clock += 16;
            stack.driver.tick(clock);
        }
    };
    stack.driver.tick(clock);
    assert.ok(stack.images.length <= 6, 'at most six loads run in flight: ' + stack.images.length);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(clock += 16);
    assert.strictEqual(stack.images.length, 6,
        'a deprioritized fetch still holds its physical slot until it settles');
    await succeedAll();
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(clock += 16);
    await succeedAll();
    assert.strictEqual(presented(host), url('long-39.jpg'), 'the end frame commits');
}

function hostWithoutScopeStaysInert() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'poster.jpg';
    host.setAttribute('data-paste-imagesequence', '#frames');
    const frames = scriptJson('frames', catalog(4));
    const stack = openStack({
        elements: {host: host, frames: frames},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    assert.strictEqual(presented(host), url('poster.jpg'), 'no scope, no sequence — the authored image stands');
    assert.strictEqual(stack.images.length, 0, 'nothing was fetched');
}

function missingCatalogStaysInert() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const host = new Element('img', 'host');
    host.src = 'poster.jpg';
    host.setAttribute('data-paste-imagesequence', '#nope');
    scope.appendChild(host);
    const stack = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
    stack.driver.tick(16);
    assert.strictEqual(presented(host), url('poster.jpg'), 'a missing catalog leaves the baseline');
    assert.strictEqual(stack.images.length, 0);
}

// Without native Promise the enhancement cannot exist: every load and
// decode completion settles through one. The module binds nothing — no
// subscription of its own, no observer, no module-started fetch — and
// the authored baseline stands through scroll, load and resize input.
// The reference page carries the same declarations with the sequence
// flag off, so its count is exactly what scrollscrub and the utilities
// legitimately own; the sequence adds zero.
async function absentPromiseLeavesEveryHostAuthored() {
    FakeSubscription.reset();
    const refScope = new Element('div', 'ref-scope');
    refScope.setAttribute('data-paste-scrollscrub', '');
    refScope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const refStack = openStack({
        elements: {scope: refScope},
        scrollscrub: true,
        imagesequence: false,
        globals: {Promise: undefined}
    });
    const baselineSubscriptions = FakeSubscription.registry.length;
    const baselineObservers = refStack.resizeObservers.length;
    const {stack, scope, host, skip} = declaredPage({
        globals: {Promise: undefined},
        intro: {to: 2, durationMs: 2000, skip: '#skip'},
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        skipId: 'skip'
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    stack.window.fireEvent('load');
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    await settlePromises();
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline stands');
    assert.strictEqual(stack.images.length, 0, 'no module-started image request');
    assert.strictEqual(
        FakeSubscription.registry.length, baselineSubscriptions,
        'the sequence bound no subscriptions of its own');
    assert.strictEqual(
        stack.resizeObservers.length, baselineObservers,
        'the sequence installed no observers');
    assert.strictEqual(skip.getAttribute('hidden'), '',
        'the skip control stays hidden — no intro started');
}

async function backgroundImageHostPaints() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        host: new Element('div', 'host'),
        baseline: null,
        imageProperty: 'background-image'
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    // The frees settle into a pass that admits the new desire; that
    // load itself lands on the next round.
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f2.jpg') + '")',
        'the frame writes background-image, never shorthand');
}

async function resolutionFlagSharpensTheDisplayedFrame() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 900, width: 1600, height: 900, left: 0, right: 1600},
        window: {devicePixelRatio: 1}
    });
    stack.driver.tick(16);
    // Frame 0 is displayed at base width 800; the host paints 1600 wide,
    // so the upgrade ladder has something worth fetching.
    stack.driver.tick(32);
    const upgrade = stack.images.filter(function (image) { return image.src === url('fHD.jpg'); })[0];
    assert.ok(upgrade, 'the sharper representation was requested');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('fHD.jpg'), 'the sharper frame commits');
}

function capRestrictsOptionalUpgrades() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 900, width: 1600, height: 900, left: 0, right: 1600}
    });
    host.computedStyle = {'--paste-resolution-max-width': '1000'};
    stack.driver.tick(16);
    stack.driver.tick(32);
    const upgrade = stack.images.filter(function (image) { return image.src === url('fHD.jpg'); })[0];
    assert.strictEqual(upgrade, undefined, 'the cap keeps the upgrade unfetched');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the baseline frame still stands');
}

// A declared range samples its own interval, endpoints inclusive — the
// catalog indices outside it stay reachable only to a declared intro.
async function explicitRangeSamplesSubset() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({sequenceFrom: 1, sequenceTo: 3});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(24);
    assert.strictEqual(presented(host), url('f1.jpg'), 'progress 0 is the declared from index');
    scrollFraction(stack, scope, 1300); // progress 0.5 → offset 1 of {1,2,3}
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(40);
    assert.strictEqual(presented(host), url('f2.jpg'), 'mid-range is the middle of the declared interval');
    scrollFraction(stack, scope, 1800); // progress 1 → index 3
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(56);
    assert.strictEqual(presented(host), url('f3.jpg'), 'the range ends on its declared last index');
}

// The hero's shape: the scroll range runs the catalog backwards. Frame
// identity stays the full-catalog index — no frames drop.
async function reverseRangeRunsBackwards() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({sequenceFrom: 3, sequenceTo: 0});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(24);
    assert.strictEqual(presented(host), url('f3.jpg'), 'progress 0 is the declared from index');
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'), 'progress 1 is the declared to index');
}

// The declared window remaps the measured span before it becomes a
// frame index — the exact fractional contract the page authored.
async function windowDeclaresThePlayableSpan() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({scopeWindow: '0.12 0.50'});
    stack.driver.tick(16);
    await settleAll(stack.images);
    // Base range is 800..1800; the window spans offsets 920..1300.
    scrollFraction(stack, scope, 890); // base 0.09 — still before the window
    stack.driver.tick(32);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f0.jpg'), 'below the window the first frame stands');
    scrollFraction(stack, scope, 1110); // base 0.31 → windowed 0.5
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(56);
    assert.strictEqual(presented(host), url('f2.jpg'), 'mid-window is the middle frame');
    scrollFraction(stack, scope, 1500); // base 0.7 — past the window
    stack.driver.tick(64);
    await settleAll(stack.images);
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f3.jpg'), 'past the window the last frame stands');
}

// The declared intro is one finite phase of the same owner: it begins
// when its first frame can paint, plays its own range on its own clock,
// and ends into the live scroll position — which here sits at the
// scroll range's start, the same pose the intro ended on.
async function introPlaysThenScrollOwns() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        catalogDocument: catalog(6),
        sequenceFrom: 5, sequenceTo: 2,
        intro: {from: 0, to: 5, durationMs: 3000, easing: 'linear'}
    });
    // Frame 0 was adopted — but adoption is identity, not readiness:
    // the intro clock waits for the standing rep's own decode proof.
    stack.driver.tick(100); // the prove fetch is the whole demand
    assert.strictEqual(presented(host), url('f0.jpg'));
    await settleAll(stack.images);
    stack.driver.tick(116); // proof landed — the clock starts here
    stack.driver.tick(866); // elapsed 750 → progress .25 → index 1
    await settleAll(stack.images);
    // The playhead only advances as fast as speculation lands the next
    // frame — index 2's fetch began when 1 painted, so its settle needs
    // its own pass before 1500ms can paint 3.
    stack.driver.tick(1216); // elapsed 1100 → index 2
    await settleAll(stack.images);
    stack.driver.tick(1616); // elapsed 1500 → index 3
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f3.jpg'), 'the intro clock advances the playhead');
    stack.driver.tick(2366); // elapsed 2250 → index 4 (floor(.75*6)=4)
    await settleAll(stack.images);
    stack.driver.tick(3116); // elapsed 3000 → the phase ends
    stack.driver.tick(3136); // the measure pass scroll owns now
    await settleAll(stack.images);
    // Progress 0 on the declared range 5→2 is index 5 — the pose the
    // intro ended within reach of, handed to the same owner.
    assert.strictEqual(presented(host), url('f5.jpg'), 'scroll ownership picks the range start');
    // And it does not come back: a later resize is not a reason to replay.
    stack.window.fireEvent('resize');
    stack.driver.tick(3150);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f5.jpg'), 'a settled intro never restarts');
}

// A scroll that moves the position ends the phase immediately — the
// user's own location outranks the intro's remaining clock.
async function scrollDuringIntroHandsOff() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear'}
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1800); // the user has scrolled — progress 1
    stack.driver.tick(500);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the live scroll position owns the frame');
    stack.driver.tick(4000); // far past the intro's end — nothing replays
    assert.strictEqual(presented(host), url('f0.jpg'));
}

// The authored skip control ends the phase and goes back to hidden —
// only while the intro ran was it ever revealed.
async function introSkipEndsPlayback() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    // Adoption is identity, not readiness — the clock waits on the
    // opening frame's own decode proof, and the skip with it.
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the intro waits on the opening frame decode');
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro exposes its skip');
    skip.fireEvent('click');
    stack.driver.tick(200);
    await settleAll(stack.images);
    assert.strictEqual(skip.getAttribute('hidden'), '', 'the skip is retired with the phase');
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f0.jpg'), 'scroll ownership at progress 0');
}

// A page already past the authored start position uses the live scroll
// state — the intro is never a reason to rewind the user.
async function currentPositionInitializationSkipsIntro() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear'},
        window: {pageYOffset: 1800}
    });
    scope.rect = {top: -200, bottom: 0, width: 100, height: 200};
    stack.driver.tick(16);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f0.jpg'), 'progress 1 on the reversed range owns immediately');
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f0.jpg'), 'no intro ever ran');
}

// Reduced motion is CSS's call: the sequence honors it with the authored
// static presentation — no intro, no frame work at all.
function reducedMotionKeepsTheBaseline() {
    FakeSubscription.reset();
    const media = {matches: true, listeners: []};
    const {stack, scope, host} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000},
        window: {
            matchMedia: function () {
                return {
                    matches: media.matches,
                    addEventListener: function (name, listener) {
                        media.listeners.push(listener);
                    },
                    removeEventListener: function () {}
                };
            }
        }
    });
    stack.driver.tick(16);
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored image stands');
    assert.strictEqual(stack.images.length, 0, 'no frame work ran at all');
}

// Hiding the document ends the phase; returning hands ownership to the
// live scroll position rather than resuming a stale clock. The end is
// observed before any scroll and long before the clock could run out:
// the hiding alone retires the skip and the playhead.
async function hiddenDocumentEndsIntro() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116); // the proven opening frame starts the clock
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro is playing');
    stack.driver.tick(1300); // elapsed 1184 → index 1
    await settleAll(stack.images);
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    assert.strictEqual(skip.getAttribute('hidden'), '',
        'hiding the document did not end the intro');
    stack.driver.tick(1700);
    await settleAll(stack.images);
    stack.driver.tick(1950); // elapsed 1834 — a live clock would be on index 2
    await settleAll(stack.images);
    stack.driver.tick(1966);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'the hidden document did not hand ownership to the live position (progress 0 → index 3): ' +
        host.src);
    stack.driver.tick(4000);
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    scrollFraction(stack, scope, 1300); // the position the user actually has
    stack.driver.tick(4100);
    await settleAll(stack.images);
    stack.driver.tick(4120);
    assert.strictEqual(presented(host), url('f1.jpg'), 'the live scroll position owns after return');
}

// A first frame that never lands keeps the baseline usable; a scroll
// still hands the sequence to the user's real position.
async function missingIntroFramePermitsScroll() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000}
    });
    stack.driver.tick(100);
    // The intro's first frame is still in flight — do not land it.
    scrollFraction(stack, scope, 1300); // the user scrolls anyway → index 1
    stack.driver.tick(500);
    stack.images.forEach(function (image) {
        if (image.src !== url('f0.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(520);
    assert.strictEqual(presented(host), url('f1.jpg'), 'scroll ownership painted the live desire');
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f1.jpg'), 'the starved intro never played');
}

// Work the intro requested that lands after handoff is stale: it caches
// like any other prepared frame and never repaints the display.
async function lateIntroCompletionDoesNotRepaint() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear'}
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116); // the opening frame's proof starts the clock
    stack.driver.tick(866); // elapsed 750: the playing intro wants index 1 — its lead goes out
    await settleAll(stack.images);
    stack.driver.tick(886); // it lands — the intro paints it for real
    assert.strictEqual(presented(host), url('f1.jpg'), 'the intro painted its current frame');
    scrollFraction(stack, scope, 1800); // handoff while late members fly
    stack.driver.tick(916);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the scroll position owns the paint');
    stack.driver.tick(5000);
    assert.strictEqual(presented(host), url('f0.jpg'), 'late intro work never reclaimed the source');
}


// Catalog srcs are authored against the document's base — the page's
// location resolves them, never the module's own bundle location.
// Absolute URLs keep their origin; relatives resolve with query intact.
async function relativeSourcesResolveAgainstTheDocumentBase() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        document: {baseURI: 'http://localhost/pages/guide/'},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450},
            {src: 'f1.jpg?v=2', width: 800, height: 450},
            {src: 'https://cdn.example.com/f2.webp?q=1', width: 800, height: 450},
            {src: '/rooted/f3.jpg', width: 800, height: 450}
        ]}
    });
    stack.driver.tick(16);
    const srcs = stack.images.map(function (image) { return image.src; });
    assert.ok(srcs.indexOf('http://localhost/pages/guide/f0.jpg') >= 0,
        'a relative frame resolves against the document base');
    assert.ok(srcs.indexOf('http://localhost/pages/guide/f1.jpg?v=2') >= 0,
        'a query rides the resolution through');
    assert.ok(srcs.indexOf('/rooted/f3.jpg') === -1,
        'a rooted path resolves rather than surviving verbatim');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    // The scrolled-away loads still hold their physical slots — the
    // desired frame starts when one settles into the scheduled pass.
    stack.images.forEach(function (image) { image.succeed(800, 450); });
    await settlePromises();
    stack.driver.tick(48);
    const absolute = stack.images.filter(function (image) {
        return image.src === 'https://cdn.example.com/f2.webp?q=1';
    })[0];
    assert.ok(absolute, 'a cross-origin absolute src keeps its own base');
}

// The preparation fetch is the same URL the host would have fetched —
// the host's authored CORS and referrer attributes ride it verbatim;
// nothing is added that the page did not declare.
function preparationCarriesAuthoredCorsAttributes() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.setAttribute('crossorigin', 'use-credentials');
    host.setAttribute('referrerpolicy', 'no-referrer');
    const {stack} = declaredPage({host: host, baseline: null});
    stack.driver.tick(16);
    assert.ok(stack.images.length > 0, 'preparation started');
    stack.images.forEach(function (image) {
        assert.strictEqual(image.crossOrigin, 'use-credentials');
        assert.strictEqual(image.referrerPolicy, 'no-referrer');
    });
}

// decode() is the completion, not load: a loaded image that cannot
// decode is a failure — the baseline stays and the frame is marked.
async function decodeRejectionKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    stack.images.forEach(function (image) {
        image.decodeShouldFail = true;
    });
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    assert.strictEqual(presented(host), url('f0.jpg'), 'an undecodable frame never paints');
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'a failed decode is not retried as painted work');
}

// Platforms without decode still complete on load — the load event is
// the fallback completion, not a second gate.
async function loadFallbackCommitsWithoutDecode() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    stack.images.forEach(function (image) {
        delete image.decode;
        image.succeed(800, 450);
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'load alone completes on a no-decode platform');
}

// No declared sequence: the module asks for nothing — no listeners,
// no observers, no frames, not even a motion-query listener.
function noDeclarationsStayQuiet() {
    FakeSubscription.reset();
    const media = {matches: false, listeners: []};
    const stack = openStack({
        elements: {},
        scrollscrub: false,
        imagesequence: true,
        window: {
            matchMedia: function () {
                return {
                    matches: media.matches,
                    addEventListener: function (name, listener) {
                        media.listeners.push(listener);
                    },
                    removeEventListener: function () {}
                };
            }
        }
    });
    stack.driver.tick(16);
    assert.strictEqual(FakeSubscription.registry.length, 0, 'no subscriptions without a host');
    assert.strictEqual(stack.resizeObservers.length, 0, 'no observers without a host');
    assert.strictEqual(stack.driver.pending(), 0, 'no frames scheduled');
    assert.strictEqual(media.listeners.length, 0, 'no media listener without a host');
    assert.strictEqual(stack.images.length, 0);
}

// Reduced motion restoring the authored presentation puts the inline
// value back verbatim — value and priority both — because the
// enhancement's paint was the only thing ever standing in for it.
async function restorePreservesTheAuthoredInlineBackground() {
    FakeSubscription.reset();
    const media = {matches: false, listeners: []};
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("poster.jpg")', 'important');
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        window: {
            matchMedia: function () {
                return {
                    get matches() {
                        return media.matches;
                    },
                    addEventListener: function (name, listener) {
                        media.listeners.push(listener);
                    },
                    removeEventListener: function () {}
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f2.jpg') + '")',
        'a frame painted over the inline baseline');
    media.matches = true;
    media.listeners.forEach(function (listener) { listener({type: 'change'}); });
    stack.driver.tick(64);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("poster.jpg")',
        'the authored inline value returns verbatim');
    assert.strictEqual(
        host.style.getPropertyPriority('background-image'),
        'important',
        'the authored priority returns with it');
}

// The authored skip keeps focus only while it owns the phase — a
// focused skip retiring hands focus deliberately to its scrollscrub
// scope rather than leaving it on a hidden control or dropping it to
// the document body. The scope is focusable only while it holds that
// focus.
async function focusedSkipIsBlurredOnRetire() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro exposes its skip');
    skip.focus();
    assert.strictEqual(stack.document.activeElement, skip, 'the skip holds focus');
    skip.fireEvent('click');
    assert.strictEqual(skip.getAttribute('hidden'), '', 'the skip retires');
    assert.strictEqual(stack.document.activeElement === skip, false,
        'focus does not stay on a hidden control');
    assert.strictEqual(stack.document.activeElement, scope,
        'focus moves to the scope that owns the sequence');
    assert.strictEqual(scope.getAttribute('tabindex'), '-1',
        'the scope is programmatically focusable while it holds focus');
    scope.blur();
    scope.fireEvent('blur');
    assert.strictEqual(scope.hasAttribute('tabindex'), false,
        'the borrowed tabindex leaves with the focus');
    stack.driver.tick(200);
    await settleAll(stack.images);
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f0.jpg'), 'scroll ownership at progress 0');
}

// Save-Data is a transfer hint, not a presentation opt-out: with all
// authored inputs equal, the connection flag changes nothing — the
// baseline still proves itself and the lookahead still prepares. The
// static-presentation decision is the authored reduced-motion
// contract alone.
function saveDataDoesNotChangeEligibility() {
    const run = function (saveData) {
        FakeSubscription.reset();
        const {stack} = declaredPage({
            window: {navigator: {connection: {saveData: saveData}}}
        });
        stack.driver.tick(16);
        return stack;
    };
    const eligible = run(false);
    const flagged = run(true);
    assert.ok(eligible.images.length > 0,
        'the control proves nothing if no frame work ran');
    assert.deepStrictEqual(
        flagged.images.map(function (image) { return image.src; }),
        eligible.images.map(function (image) { return image.src; }),
        'a save-data connection suppressed declared frame work');
}

// Reduced motion flipping mid-flight withdraws animated intent: the
// baseline restores immediately, and the pending frame completing a
// moment later is dead work — it can never paint over it.
async function reducedMotionMidFlightKeepsTheBaseline() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // progress 0.5 → frame 2 flies
    stack.driver.tick(32);
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(f2, 'frame 2 is in flight');
    motion.set(true); // the preference flips: the baseline restores
    stack.driver.tick(48);
    f2.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64); // the completion's pass runs — and refuses
    assert.strictEqual(presented(host), url('f0.jpg'),
        'a completion from withdrawn intent never paints over the baseline');
}

// The decoded budget counts everything the module owns — retained
// frames, work still in flight, and the candidate itself. Optional
// lookahead that cannot fit alongside a pending fetch is refused, not
// admitted on faith; the settle that frees the accounting is what
// lets the live window resume. A retained speculation is reclaimable
// — once the desire moves on, its pixels make room for useful work
// before any refusal is answered, and nothing refetches them.
async function decodedBudgetCountsAllOwnedWork() {
    FakeSubscription.reset();
    // f1 alone is ~32 MB — beside retained f0 (~1.3 MB) it just fits,
    // but it leaves no room for anything else until it is evicted.
    const {stack, scope, host} = declaredPage({
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800,
                upgrades: [{src: 'u0.jpg', width: 450, height: 900}]},
            {src: 'f1.jpg', width: 2000, height: 4000, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800,
                upgrades: [{src: 'u2.jpg', width: 450, height: 900}]},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f4.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f5.jpg', width: 400, height: 800, upgrades: []}
        ]},
        // 400 wide: the base covers the measured need, so frame
        // requests carry base sources — and the f1 speculation fits in
        // flight next to f0, 1.3 + 32 just under 32 MiB, leaving no
        // room for anything else.
        hostRect: {top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800}
    });
    stack.driver.tick(16);
    // The enhancement genuinely bound: an observer exists and real
    // work is in flight — this scenario cannot pass vacuously.
    assert.ok(stack.resizeObservers.length >= 1, 'the sequence bound and watches');
    const f0 = stack.images.filter(function (image) { return image.src === url('f0.jpg'); })[0];
    const f1 = stack.images.filter(function (image) { return image.src === url('f1.jpg'); })[0];
    assert.ok(f0 && f1, 'the desired frame and its speculative neighbor are in flight');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'farther lookahead cannot fit beside the occupied accounting');
    f0.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(24);
    assert.strictEqual(presented(host), url('f0.jpg'), 'frame zero displayed');
    // Retained 1.3 + in-flight 32: the rest of the window is refused
    // while f1 occupies the accounting — in-flight work is not
    // reclaimable.
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the pending speculation still blocks the live window');

    scrollFraction(stack, scope, 1200); // progress 0.4 → desire moves to frame 2
    stack.driver.tick(32);
    // Demand never queues — but the account is full of owned work, and
    // an ordinary desire at 1.3 MB is not the individually oversized
    // exception: it waits on the pending speculation's settle, which is
    // owned accounting whether its result is still wanted or not.
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the new desire waits on owned capacity — no exemption past the budget');
    f1.succeed(2000, 4000); // the speculation lands and retains
    await settlePromises();
    stack.driver.tick(40);
    // Its settle was the only event: the pass reclaims the retained
    // pixels — obsolete against the new window — and the waiting
    // desire admits with the live window behind it.
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the settle frees the account — the waiting desire admits');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f3.jpg');
    }), 'reclaim on settle resumes the window — a full cache is evicted, not a dead end');
    stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(56);
    assert.strictEqual(presented(host), url('f2.jpg'), 'frame two displays');
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(72);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    }).length, 1, 'the reclaimed speculation is never refetched — no evict-admit loop');
}

// A refusal for capacity is not a permanent answer: the upgrade is
// recorded only at admission, so the settle that frees a slot is what
// lets the waiting sharpen start — it is never stranded.
async function capacitySettleRetriesAWaitingUpgrade() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'sharp.jpg', width: 1920, height: 1080}],
        hostRect: {top: 0, bottom: 450, width: 800, height: 450, left: 0, right: 800}
    });
    stack.driver.tick(16);
    // Painted at base width, no upgrade is wanted yet — but fill both
    // physical slots with frame work before the box grows.
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 1080, width: 1920, height: 1080, left: 0, right: 1920};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) { return image.src === url('sharp.jpg'); }),
        'the waiting upgrade admits once a slot settles');
}

// The frame an intro waited on fails: the wait is over — the live
// scroll position takes ownership of the desire immediately, not on
// the next input that happens to move the page.
async function failedIntroFrameHandsScrollOwnership() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        intro: {durationMs: 3000, from: 2, to: 3}
    });
    stack.driver.tick(16);
    const introFirst = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(introFirst, 'the intro waits on its first frame');
    introFirst.fail();
    await settlePromises();
    stack.driver.tick(32);
    const f0 = stack.images.filter(function (image) { return image.src === url('f0.jpg'); })[0];
    assert.ok(f0, 'the scroll-owned frame was requested');
    f0.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the live scroll frame paints after the failed wait');
}

// Native responsive selection already owns srcset and picture content:
// a sequence declared on such a host binds nothing at all.
async function nativeSrcsetKeepsNativeOwnership() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'f0.jpg';
    host.setAttribute('srcset', 'f0.jpg 1x, f0-2x.jpg 2x');
    const {stack} = declaredPage({host: host});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'native ownership stays authoritative — no sequence loads');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored source stands');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 0,
        'a natively governed img is left to the browser, not reported');
}

// An img carrying sizes without srcset is natively governed too — the
// module never overwrites an authored sizes — so it is skipped, as
// progressiveresolution also treats it.
async function sizesOnlyImgKeepsNativeOwnership() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'f0.jpg';
    host.setAttribute('sizes', '50vw');
    const {stack, scope} = declaredPage({host: host, resolution: true});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0, 'a sizes-only img was bound');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored source stands');
    assert.strictEqual(host.getAttribute('sizes'), '50vw', 'the authored sizes was touched');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 0, 'a sizes-only img was reported');
}

// Resolution demand is honest about the fit the display applies: an
// image host's object-fit cover scales the intrinsic size, so the need
// lands on the larger candidate — not the one plain painted width
// would suggest.
async function objectFitCoverDemandsTheLargerCandidate() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800, upgrades: [
                {src: 'up-800.jpg', width: 800, height: 1600},
                {src: 'up-1920.jpg', width: 1920, height: 3840}
            ]},
            {src: 'f1.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        hostRect: {top: 0, left: 0, width: 500, height: 2400, right: 500, bottom: 2400}
    });
    host.computedStyle = {'object-fit': 'cover'};
    stack.driver.tick(16);
    stack.driver.tick(32);
    // cover: scale = max(500/400, 2400/800) = 3 → need 1200 → 1920 wins.
    assert.ok(stack.images.some(function (image) { return image.src === url('up-1920.jpg'); }),
        'the cover-cropped need selects the larger representation');
    assert.ok(!stack.images.some(function (image) { return image.src === url('up-800.jpg'); }),
        'the painted-width answer is not the cropped answer');
}

// An img writes a sharper rung as a srcset width descriptor sized at
// the base's intrinsic width, so the rung paints the same box at more
// density: under object-fit none or a non-shrinking scale-down the need
// is still the base width times the device pixel ratio.
async function intrinsicFitImgDemandsDensity() {
    for (const fit of ['none', 'scale-down']) {
        FakeSubscription.reset();
        const {stack, host} = declaredPage({
            resolution: true,
            catalogDocument: {frames: [0, 1, 2, 3].map(function (index) {
                return {src: 'f' + index + '.jpg', width: 800, height: 450,
                    upgrades: [{src: 'f' + index + '-1600.jpg', width: 1600, height: 900}]};
            })},
            hostRect: {top: 0, left: 0, width: 800, height: 450, right: 800, bottom: 450},
            window: {devicePixelRatio: 2}
        });
        host.computedStyle = {'object-fit': fit};
        stack.driver.tick(16);
        stack.driver.tick(32);
        assert.ok(stack.images.some(function (image) { return image.src === url('f0-1600.jpg'); }),
            'object-fit ' + fit + ' at a pixel ratio of 2 requests the density rung');
    }
}

// Sequences measuring the same root share its one scroll input, and
// the module holds a single resize subscription for all of them.
function sharedRootsShareInputSubscriptions() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const firstHost = new Element('img', 'host-a');
    firstHost.src = 'a0.jpg';
    firstHost.setAttribute('data-paste-imagesequence', '#frames-a');
    const secondHost = new Element('img', 'host-b');
    secondHost.src = 'b0.jpg';
    secondHost.setAttribute('data-paste-imagesequence', '#frames-b');
    scope.appendChild(firstHost);
    scope.appendChild(scriptJson('frames-a', catalog(4)));
    scope.appendChild(secondHost);
    scope.appendChild(scriptJson('frames-b', catalog(4)));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: false,
        imagesequence: true
    });
    stack.driver.tick(16);
    const scrollSubs = FakeSubscription.registry.filter(function (sub) {
        return sub.name === 'scroll' && sub.target === stack.window;
    });
    const resizeSubs = FakeSubscription.registry.filter(function (sub) {
        return sub.name === 'resize' && sub.target === stack.window;
    });
    assert.strictEqual(scrollSubs.length, 1, 'one scroll subscription for the shared root');
    assert.strictEqual(resizeSubs.length, 1, 'one resize subscription for the module');
}

// Superseded upgrade work still owns its accounting: a growing need
// admits the newest source while an older operation is still
// outstanding, and every operation keeps its own record until it
// settles — an older op's settle can never delete a newer op's
// accounting or replay a want that moved on.
async function supersededUpgradesKeepTheirPhysicalSlots() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800, upgrades: [
                {src: 'up-900.jpg', width: 900, height: 1800},
                {src: 'up-1200.jpg', width: 1200, height: 2400}
            ]},
            // Big enough that speculation is always budget-refused —
            // this test watches upgrade work alone.
            {src: 'f1.jpg', width: 2100, height: 4200, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        // 400 wide: the base covers the need, so frame zero fetches
        // its base and only a real need growth admits a sharpen.
        hostRect: {top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800}
    });
    stack.driver.tick(16);
    const f0 = stack.images.filter(function (image) { return image.src === url('f0.jpg'); })[0];
    assert.ok(f0, 'frame zero requested its selected tier — the base');
    f0.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(24);
    assert.strictEqual(presented(host), url('f0.jpg'), 'frame zero displayed');

    // The need grows while nothing has settled — each want admits its
    // own operation with its own record.
    host.rect = {top: 0, bottom: 800, left: 0, right: 500, width: 500, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.ok(stack.images.some(function (image) { return image.src === url('up-900.jpg'); }),
        'the first growth admits its sharpen');
    host.rect = {top: 0, bottom: 800, left: 0, right: 1150, width: 1150, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) { return image.src === url('up-1200.jpg'); }),
        'the second growth admits its own operation while the first is outstanding');

    // The older op's settle frees only its own record: its landed rep
    // is the sharper proven paint, and the newer want stays admitted
    // — never lost to the older settle's bookkeeping.
    stack.images.filter(function (image) {
        return image.src === url('up-900.jpg');
    })[0].succeed(900, 1800);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('up-900.jpg'), 'the landed sharpen paints');
    stack.images.filter(function (image) {
        return image.src === url('up-1200.jpg');
    })[0].succeed(1200, 2400);
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('up-1200.jpg'), 'the newer intent paints when it lands');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('up-1200.jpg');
    }).length, 1, 'an older settle never lost the newer request to re-admission');
}

// The request ledger is keyed by the physical resource, not the frame
// slot: a demand that re-selects a different representation of a frame
// still loading records a new operation, never overwrites the pending
// one's record. Six physical requests is the ceiling however many
// resolutions one frame cycles through while nothing settles.
async function resolutionGrowthKeepsEveryPendingOperation() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0-400.jpg', width: 400, height: 400, upgrades: [
                {src: 'f0-600.jpg', width: 600, height: 600},
                {src: 'f0-800.jpg', width: 800, height: 800},
                {src: 'f0-1000.jpg', width: 1000, height: 1000},
                {src: 'f0-1400.jpg', width: 1400, height: 1400},
                {src: 'f0-1800.jpg', width: 1800, height: 1800},
                {src: 'f0-2200.jpg', width: 2200, height: 2200},
                {src: 'f0-2600.jpg', width: 2600, height: 2600}
            ]},
            // Neighbors too large for the decoded budget keep the
            // window's speculation out of the accounting — frame
            // zero's re-selections are the only work the test runs.
            {src: 'f1.jpg', width: 2100, height: 4200, upgrades: []},
            {src: 'f2.jpg', width: 2100, height: 4200, upgrades: []},
            {src: 'f3.jpg', width: 2100, height: 4200, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800}
    });
    stack.driver.tick(16);
    // Eight selectable representations of one frame, each growth
    // measured while every earlier load stays unresolved.
    [600, 800, 1000, 1400, 1800, 2200, 2600].forEach(function (width) {
        host.rect = {top: 0, bottom: 800, left: 0, right: width,
            width: width, height: 800};
        stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
        stack.driver.tick(16);
    });
    assert.ok(stack.images.length <= 6,
        're-selecting unresolved representations stays inside six ' +
            'physical requests — ' + stack.images.length + ' ran');
    const srcs = stack.images.map(function (image) { return image.src; });
    assert.strictEqual(new Set(srcs).size, srcs.length,
        'no physical resource was requested twice');
    // A reversal lands on a representation already outstanding: the
    // dedupe answers by URL, so nothing new starts and nothing is lost.
    host.rect = {top: 0, bottom: 800, left: 0, right: 400, width: 400, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(24);
    assert.strictEqual(stack.images.length, srcs.length,
        'returning to a pending representation requests nothing new');
    // Every earlier operation still owns its record: one settle frees
    // exactly one slot, and the latest useful want takes it.
    stack.images[0].succeed(400, 400);
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(stack.images.length <= srcs.length + 1,
        'one settle frees exactly one slot — no lost record lets demand over-admit');
}

// A neighbor fetch the decoded budget cannot hold is refused at
// admission — never admitted, evicted on arrival, and re-requested in
// an idle loop.
async function speculativeNeighborRespectsTheDecodedBudget() {
    FakeSubscription.reset();
    const {stack} = declaredPage({
        baseline: null,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 2000, height: 4000, upgrades: []},
            {src: 'f1.jpg', width: 2000, height: 4000, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg'), url('f2.jpg')],
        'the ~32 MB member is refused while the small member that fits admits');
    stack.images[0].succeed(2000, 4000);
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(!stack.images.some(function (image) { return image.src === url('f1.jpg'); }),
        'committed and retained, the budget still cannot hold the ~32 MB member');
    stack.driver.tick(48);
    assert.ok(!stack.images.some(function (image) { return image.src === url('f1.jpg'); }),
        'nothing re-requests the refused member — no eviction loop');
}

// An optional representation cached before a policy fall cannot paint
// through the cache: revisiting the frame rechecks the cap, and the
// base representation is what gets fetched.
async function cachedUpgradeRepRespectsTheCapOnRepaint() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800,
                upgrades: [{src: 'up-1600.jpg', width: 1600, height: 3200}]},
            {src: 'f1.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900}
    });
    stack.driver.tick(16);
    const upgrade = stack.images.filter(function (image) {
        return image.src === url('up-1600.jpg');
    })[0];
    assert.ok(upgrade, 'the sharper candidate was admitted while policy allowed');
    // The cap falls and a pass measures it before the fetch lands: a
    // rep that can never paint must not displace the paintable base —
    // the completion drops it instead of parking it.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.driver.tick(24);
    upgrade.succeed(1600, 3200);
    await settlePromises();
    stack.driver.tick(30);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the over-cap upgrade never paints');

    scrollFraction(stack, scope, 1300); // frame 2
    stack.driver.tick(32);
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(f2, 'the middle frame is fetched');
    f2.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(40);
    assert.strictEqual(presented(host), url('f2.jpg'));

    scrollFraction(stack, scope, 0); // back to frame 0
    stack.driver.tick(48);
    // The refused upgrade never entered the cache — only the authored
    // base's unproven entry remains, so the revisit proves it with its
    // own fetch before it can paint. The regressed shape painted the
    // over-cap rep straight from prepared[0].
    const revisit = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(revisit, 'the base rep is fetched — an ineligible rep cannot stand in');
    revisit.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the revisit paints the proven base — an ineligible rep cannot paint');
}

// An upgrade that lands after the user moved on is still owned work —
// its decoded estimate must reconcile against the budget at settle,
// not linger until the next paint. Otherwise the cache quietly holds
// tens of MB over budget and an old rep stays paintable on revisit.
// The settle's reconcile is also what funds the moved-on desire: no
// ordinary admission skips the account, and a repaint whose tier
// cannot coexist with the standing image cannot be funded at all —
// the displayed presentation is unavoidable ownership, never
// reclaimed out from under the paint.
async function lateUpgradeIsReconciledAtSettle() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 1200, height: 2400,
                upgrades: [{src: 'u0.jpg', width: 1500, height: 3000}]},
            {src: 'f1.jpg', width: 1800, height: 3600, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 1200, left: 0, right: 2000, width: 2000, height: 1200}
    });
    stack.driver.tick(16);
    // need ~2000 → the selected representation is u0 (~18 MB): frame
    // zero's request carries its measured tier directly, and the ~26
    // MB member cannot join it in flight.
    const u0 = stack.images.filter(function (image) { return image.src === url('u0.jpg'); })[0];
    assert.ok(u0, 'frame zero requested its selected tier');
    assert.ok(!stack.images.some(function (image) { return image.src === url('f0.jpg'); }),
        'no base-first fetch ran beneath the selected tier');
    assert.ok(!stack.images.some(function (image) { return image.src === url('f1.jpg'); }),
        'the oversized member stayed refused beside the in-flight work');

    scrollFraction(stack, scope, 1200); // progress 0.4 → desire moves to frame 1
    stack.driver.tick(32);
    // ~26 MB beside the in-flight ~18 MB cannot admit — the desire is
    // mandatory but not individually oversized, so it waits for the
    // pending work to settle rather than fetching past the account.
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the desired frame waits on owned capacity — the account is full');
    // The stale tier settles after the intent moved on — its decoded
    // estimate reconciles at settle, never lingering over budget, and
    // the room it frees funds the waiting desire.
    u0.succeed(1500, 3000);
    await settlePromises();
    stack.driver.tick(40);
    const f1 = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0];
    assert.ok(f1, 'the settle reclaims the stale tier — the desire admits');
    f1.succeed(1800, 3600);
    await settlePromises();
    stack.driver.tick(56);
    assert.strictEqual(presented(host), url('f1.jpg'), 'frame one displays (~25.9 MB retained)');

    scrollFraction(stack, scope, 0); // back to frame 0
    stack.driver.tick(64);
    // The standing ~26 MB presentation plus the ~18 MB revisit can
    // never coexist in the account, so accounting alone would hold the
    // paint on frame one forever. The mandatory, ungated desire is the
    // single-frame exception: it admits once, alone.
    const revisits = function () {
        return stack.images.filter(function (image) {
            return image.src === url('u0.jpg');
        });
    };
    assert.strictEqual(revisits().length, 2,
        'the revisit admits under the single-frame exception');
    stack.driver.tick(72);
    assert.strictEqual(revisits().length, 2,
        'one exceptional request outstanding — never a duplicate');
    revisits()[1].succeed(1500, 3000);
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('u0.jpg'),
        'the revisit paints once it settles');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the base was never requested at any point');
}

// A sequence whose scene sits beyond the approaching band binds — its
// listeners and observers are live — but spends nothing on imagery
// until the subject is within a viewport of being seen. Once the page
// scrolls it into the band, the pending desire admits and paints.
async function offscreenSequenceDefersWorkUntilNear() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        catalogDocument: catalog(4),
        scopeRect: {top: 5000, bottom: 5200, width: 100, height: 200}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a scene three viewports out requests nothing at bind');
    assert.ok(stack.resizeObservers.length > 0,
        'the offscreen sequence is still bound — only its work waits');

    // Scrolled to a spot where the subject sits at the viewport's own
    // top edge — inside the band, not yet inside the range.
    scrollTo(stack, scope, 4000);
    scope.rect = {top: 1000, bottom: 1200, width: 100, height: 200};
    stack.driver.tick(32);
    const f0 = stack.images.filter(function (image) { return image.src === url('f0.jpg'); })[0];
    assert.ok(f0, 'approaching the band starts the desired frame');
    f0.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the frame paints once the scene is near');
}

// Out-of-order upgrade completion: a larger rep lands and displays
// first, then an older smaller rep completes. The smaller result must
// not replace the cache entry that stands in for the displayed image —
// the accounting would then undercount by the difference and admit
// work the true footprint cannot afford.
async function outOfOrderUpgradeKeepsTheDisplayedAccounting() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800, upgrades: [
                {src: 'up-800.jpg', width: 800, height: 1600},
                {src: 'up-1600.jpg', width: 1600, height: 3200},
                {src: 'up-1800.jpg', width: 1800, height: 3600}
            ]},
            {src: 'f1.jpg', width: 2000, height: 4000, upgrades: []},
            {src: 'f2.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 900, left: 0, right: 700, width: 700, height: 900}
    });
    const imageFor = function (src) {
        return stack.images.filter(function (image) { return image.src === url(src); })[0];
    };
    stack.driver.tick(16);
    assert.ok(imageFor('up-800.jpg'), 'the first need admits up-800');
    assert.ok(!imageFor('up-1600.jpg'), 'one tier, not a ladder, answers the need');

    host.rect = {top: 0, bottom: 900, left: 0, right: 1500, width: 1500, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.ok(imageFor('up-1600.jpg'), 'the grown need admits up-1600');

    // The later request lands first — it is sharper and paints.
    imageFor('up-1600.jpg').succeed(1600, 3200);
    await settlePromises();
    stack.driver.tick(40);
    assert.strictEqual(presented(host), url('up-1600.jpg'), 'the larger rep displays first');

    // Now the older, smaller completion arrives. The displayed rep's
    // accounting entry is not replaceable by it.
    imageFor('up-800.jpg').succeed(800, 1600);
    await settlePromises();
    stack.driver.tick(56);
    assert.strictEqual(presented(host), url('up-1600.jpg'), 'a stale smaller rep never repaints');

    // The proof is the next admission: up-1800 (~25.9 MB) fits a
    // budget only if up-800 (~5.1 MB) displaced the accounting — with
    // up-1600 (~20.5 MB) honestly counted it cannot fit.
    host.rect = {top: 0, bottom: 900, left: 0, right: 1700, width: 1700, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(!stack.images.some(function (image) { return image.src === url('up-1800.jpg'); }),
        'the displayed rep still counts — the budget refuses the next upgrade');
}

// Optional work never waits for the document's own load event: a
// stalled unrelated resource must not hold every upgrade and lookahead
// hostage. With the document still interactive, the first pass proves
// the baseline and speculates ahead and a standing frame sharpens; the
// module's only load subscription is its one-shot re-measure, which
// nothing waits on.
async function optionalWorkNeverWaitsForTheDocumentLoad() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        document: {readyState: 'interactive'},
        // scrollscrub's own one-shot load re-measure is not this
        // module's; the sequence measures through scrollrange itself.
        scrollscrub: false,
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg'), url('f1.jpg'), url('f2.jpg'), url('f3.jpg')],
        'the baseline proof and the lookahead start while the document loads');
    const loadInputs = FakeSubscription.registry.filter(function (subscription) {
        return subscription.name === 'load' && subscription.target === stack.window;
    });
    assert.strictEqual(loadInputs.length, 1, 'the one-shot load re-measure is missing');
    assert.strictEqual(loadInputs[0].executeCount, 1, 'the load re-measure outlives its one delivery');
    await settleAll(stack.images);
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) { return image.src === url('u-1600.jpg'); }),
        'the standing frame\'s sharpening waited on the document load');
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u-1600.jpg'), 'the sharper frame paints before load');
}

// An authored img still fetching is displayed, not decoded — matching
// its URL is no readiness proof. The intro's clock begins only when the
// frame's own arrival reports; the sequence proves the same URL with
// its own request, deduplicated by the platform's fetch.
async function unreadyAuthoredFrameGatesTheIntroClock() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, host: bound, skip} = declaredPage({
        host: host,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'nothing ready — the intro has not begun');
    assert.strictEqual(presented(bound), url('f0.jpg'), 'the authored baseline stands');
    const base = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(base, 'the sequence proves the adopted frame with its own request');
    stack.driver.tick(4000); // past the authored duration
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the clock never consumed the intro early');
    base.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(101); // the completion's pass converts the wait
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the real arrival starts the clock');
    await settleAll(stack.images);
    stack.driver.tick(4100);
    await settlePromises();
    stack.driver.tick(7300); // elapsed 3200 ≥ duration — the phase ends
    stack.driver.tick(7400);
    await settleAll(stack.images);
    assert.strictEqual(presented(bound), url('f0.jpg'),
        'the intro ends into the live scroll position — frame 0 stands');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the skip retires with the phase');
}

// Optional admission is deferred, never queued: a pass can contemplate
// a speculative neighbor and an optional upgrade all it likes while
// the page is still loading — nothing is admitted, and nothing is
// remembered to replay later. When the scroll then demands that same
// content its requirement lands on the demand path immediately, and
// because every frame declares the same upgrade URL the demand is
// satisfied by the one physical op already proving it — no duplicate
// fetch, no contemplation occupying a slot. A jump to the far end
// resolves against the same resource, and its completion proves every
// alias at once.
async function contemplatedSpeculationNeverBlocksDemand() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        document: {readyState: 'interactive'},
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700}
    });
    stack.driver.tick(16);
    // The standing baseline still owes its decode proof — demanded
    // work, on its selected tier; only speculation contemplated and
    // held.
    assert.strictEqual(stack.images.length, 1,
        'only the baseline proof was demanded — speculation waited');
    assert.strictEqual(stack.images[0].src, url('u-1600.jpg'),
        'the proof fetch is the selected tier, not a wasted base hit');
    scrollFraction(stack, scope, 1100); // the contemplated neighbor becomes the demand
    stack.driver.tick(32);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u-1600.jpg');
    }).length, 1,
        'one URL is one physical op — the demand piggybacks, never duplicates');
    assert.ok(!stack.images.some(function (image) { return image.src === url('f1.jpg'); }),
        'no base-first fetch ran beneath the demand');
    scrollFraction(stack, scope, 1800); // a jump to the far end
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u-1600.jpg');
    }).length, 1,
        'the jump resolves to the same resource — still a single op');
    stack.images[0].succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u-1600.jpg'),
        'one completion proves every alias — the far frame paints the tier');
}

// Static presentation still refines the declared initial frame: the
// authored frame zero is the presentation, and its resolution upgrade
// is refinement work, not animation — it requests, it paints when it
// lands, and no intro or neighboring-frame work ever runs beside it.
async function reducedMotionRefinesOnlyFrameZero() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('u-1600.jpg')],
        'only the frame-zero refinement requests — never an animated frame');
    stack.images[0].succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('u-1600.jpg'),
        'the landed refinement paints without further input');
    // A cap that lands afterward rules further rungs out — and a pass
    // that re-measures adds no animated work beside the refinement.
    host.computedStyle = {'--paste-resolution-max-width': '1000'};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u-1600.jpg'),
        'the painted refinement is not unwound by a later cap');
    assert.strictEqual(stack.images.length, 1,
        'no new request follows a policy change — painted or animated');
}

// Motion reduced mid-session is the same static presentation reached
// from the other side: the baseline restores, only frame zero may
// refine itself, and the settled refinement still paints. Bound while
// the page loads, no speculation ever ran to confuse the accounting.
async function switchingToReducedMotionStillRefines() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, host} = declaredPage({
        document: {readyState: 'interactive'},
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    motion.set(true);
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline restores');
    // The standing baseline owes its decode proof on the selected
    // tier — the same demand as the refinement; one request, already
    // running before load.
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('u-1600.jpg')],
        'the frame-zero refinement demand already ran — nothing else did');
    stack.window.fireEvent('load');
    stack.driver.tick(48);
    const upgrade = stack.images.filter(function (image) {
        return image.src === url('u-1600.jpg');
    })[0];
    assert.ok(upgrade, 'the frame-zero refinement is admitted under static presentation');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u-1600.jpg'),
        'the refinement that landed after the switch still paints');
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('u-1600.jpg')],
        'the refinement is the only request the static page ever made');
}

// A MediaQueryList carrying only the legacy listener API still binds:
// registration must not throw, the enhancement runs, and a change the
// old-style callback reports is honoured like any other flip. A query
// object with no listener API at all leaves the enhancement bound and
// inert to motion changes — never an initialization error.
async function legacyAndInertMediaQueriesStillEnhance() {
    FakeSubscription.reset();
    const legacy = {
        matches: false,
        listeners: [],
        addListener: function (listener) { legacy.listeners.push(listener); },
        removeListener: function () {},
        set: function (value) {
            legacy.matches = value;
            legacy.listeners.slice().forEach(function (listener) {
                listener({matches: value});
            });
        }
    };
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return legacy; }}
    });
    stack.driver.tick(16);
    assert.ok(stack.resizeObservers.length >= 1,
        'the enhancement bound under the legacy query API');
    scrollFraction(stack, scope, 1300); // progress 0.5 → frame 2 flies
    stack.driver.tick(32);
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(f2, 'frame work is in flight under the legacy query');
    legacy.set(true);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'a change the legacy callback reports restores the baseline');
    f2.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the late completion never paints over the restored baseline');

    // Neither listener API at all is an unobservable live query, not
    // an inert one: the module cannot tell a permanently-false
    // preference from one it simply never hears, so every sequence
    // stands down rather than animate behind a reduced-motion user's
    // back.
    const silent = {matches: false};
    const silentPage = declaredPage({
        window: {matchMedia: function () { return silent; }}
    });
    silentPage.stack.driver.tick(16);
    assert.ok(silentPage.stack.resizeObservers.length >= 1,
        'the enhancement still bound with no query listener API at all');
    scrollFraction(silentPage.stack, silentPage.scope, 1300);
    silentPage.stack.driver.tick(32);
    assert.strictEqual(silentPage.stack.images.length, 0,
        'frame work proceeded on a query the module cannot observe');
    assert.strictEqual(presented(silentPage.host), url('f0.jpg'),
        'the authored baseline stands behind an unobservable query');
}

// A poster that is not frame zero never refines under static
// presentation — the authored image was not declared as the opening
// pose, so sharpening it into one would invent a pose the author
// never painted.
async function reducedMotionLeavesANonzeroPosterAlone() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const {stack, host} = declaredPage({
        baseline: 'f2.jpg',
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    stack.driver.tick(4000);
    assert.strictEqual(stack.images.length, 0, 'no work at all for a non-initial poster');
    assert.strictEqual(presented(host), url('f2.jpg'), 'the authored poster stands untouched');
}

// Readiness is affirmative and survives release: an authored baseline
// that never proved its pixels stays unproven when the scene leaves
// and returns — the skip stays hidden and the clock stays stopped
// until the sequence's own proof arrives: the rebuilt displayed entry
// keeps its readiness, so the intro never starts on nothing at all.
async function unprovenBaselineKeepsIntroWaitingThroughLeaveAndReturn() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, scope, skip} = declaredPage({
        host: host,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    const proof = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(proof, 'the proof request is in flight');
    // Leave the approaching band, then return through the layout alone
    // — the scroll offset never moved.
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(132);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(164);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'release preserved the unproven state — the intro never started');
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(196);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the genuine arrival — not the re-entry — starts the clock');
}

// The other side of the same preservation: a baseline that did prove
// itself keeps that proof through release — the intro can open on
// re-entry with zero new fetches.
async function provenBaselineSurvivesRelease() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = true;
    host.naturalWidth = 800;
    const {stack, scope, skip} = declaredPage({
        host: host,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        scopeRect: {top: 9000, bottom: 9200, width: 100, height: 200}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'a far scene fetches nothing');
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'no clock without proximity');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    const proof = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(proof, 'the opening frame owes its decode proof');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'no clock before the proof lands');
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the proven frame opens the intro');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1,
        'the proof was the only readiness request the intro needed');
    // Leaving and returning keeps it: the displayed entry's proven
    // state rides through release untouched.
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1,
        'the proven displayed frame is never re-proven after release');
}

// A settled request that produced no pixels is a dead frame: the intro
// never waits on it, and the live scroll position owns the sequence
// from the start — the authored content stands meanwhile.
async function brokenAuthoredFrameSkipsTheIntro() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = true;
    host.naturalWidth = 0;
    const {stack, scope, skip} = declaredPage({
        host: host,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a proven-dead frame never opens an intro');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(200);
    const desired = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(desired, 'the live position fetches its frame — no wedge');
    desired.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(250);
    assert.strictEqual(presented(host), url('f2.jpg'), 'scroll owns the presentation');
}

// A background host carries no readiness surface — the baseline stands
// as content, but the intro's clock still waits on the sequence's own
// arrival proof for the same URL.
async function backgroundBaselineProvesItselfBeforeTheIntro() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("f0.jpg")');
    const {stack, skip} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'no readiness signal — the clock waits');
    const base = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(base, 'the sequence proves the adopted background itself');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("f0.jpg")',
        'the authored baseline is never rewritten as a side effect');
    base.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(101); // the ready trigger fires in the pass
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the real arrival starts the intro');
}

// Identical start and end anchors are an invalid range, not a zero
// position: progress measures null and the intro never begins. The
// authored image is the whole presentation.
async function degenerateRangeKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        scopeStart: 'top top',
        scopeEnd: 'top top',
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    assert.strictEqual(presented(host), url('f0.jpg'), 'an unmeasurable range keeps the baseline');
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'no intro ever ran');
    assert.strictEqual(stack.images.length, 0,
        'an invalid range admits no frame work');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(200);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'scrolling changes nothing — the range has no span');
}

// Leaving the approaching band ends the scene's claim on decoded
// memory: retained frames release to just the painted representation,
// and a completion landing after the exit parks nothing. The proof is
// the return — a released frame must fetch again.
async function leavingTheSceneReleasesTheCache() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // progress 0.5 → frame 2
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'frame two displayed, neighbors retained');
    await settleAll(stack.images); // the paint pass's speculations land too

    // Out beyond the band — the subject is nowhere near seen.
    scrollTo(stack, scope, 9000);
    scope.rect = {top: -7500, bottom: -7300, width: 100, height: 200};
    stack.driver.tick(64);

    // Back into the band at the far end: the released window member
    // fetches again — the displayed frame's pixels never needed to.
    scrollFraction(stack, scope, 1800); // progress 1 → desire 3
    stack.driver.tick(80);
    const f3Requests = stack.images.filter(function (image) {
        return image.src === url('f3.jpg');
    }).length;
    assert.strictEqual(f3Requests, 2,
        'a released neighbor refetches on approach — it was not retained');
    const f2Requests = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).length;
    assert.strictEqual(f2Requests, 1,
        'the displayed frame keeps its pixels — the baseline stands');
}

// A request outstanding when the scene leaves still settles — its
// physical slot was real until then — but its result parks nowhere:
// the re-approach fetches it again.
async function postLeaveCompletionRetainsNothing() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({baseline: null});
    stack.driver.tick(16);
    const f3 = stack.images.filter(function (image) {
        return image.src === url('f3.jpg');
    })[0];
    assert.ok(f3, 'the speculative lookahead member was in flight');

    scrollTo(stack, scope, 9000);
    scope.rect = {top: -7500, bottom: -7300, width: 100, height: 200};
    stack.driver.tick(32);
    f3.succeed(800, 450); // lands after the exit — must not park
    await settlePromises();
    stack.driver.tick(48);

    scrollFraction(stack, scope, 1800); // progress 1 → desire 3
    stack.driver.tick(64);
    const f3Requests = stack.images.filter(function (image) {
        return image.src === url('f3.jpg');
    }).length;
    assert.strictEqual(f3Requests, 2,
        'the post-exit completion was dropped — the return refetches');
}

// A range collapsing mid-intro stops the phase outright: the skip
// retires, the clock's outstanding intent is withdrawn, and the playhead
// never resumes on its own.
async function collapsedRangeStopsAnActiveIntro() {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        scopeStart: 'top top',
        scopeEnd: 'bottom top',
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(100);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro is running');

    // The subject collapses while the clock ticks.
    scope.rect = {top: 0, bottom: 0, width: 100, height: 0};
    stack.window.fireEvent('scroll');
    stack.driver.tick(500);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the intro stopped with its skip retired');
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the dead range never replays the intro');
}

// A range that stops measuring withdraws the desire it carried: a
// completion from that intent is dead work — it lands in the cache
// but never paints. Restoring the range re-drives from the live
// position and the retained frame is still the answer.
async function collapsedRangeWithdrawsThePendingDesire() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scopeStart: 'top top',
        scopeEnd: 'bottom top'
    });
    stack.driver.tick(16);
    // Anchors top..bottom on a 200-tall subject: S=top, E=bottom — a
    // live range while the subject has height.
    scrollFraction(stack, scope, 1700);
    scope.rect = {top: -100, bottom: 100, width: 100, height: 200};
    stack.driver.tick(32);
    const f2 = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(f2, 'the desired frame is in flight');

    // The subject collapses mid-flight — the range goes degenerate.
    scope.rect = {top: 0, bottom: 0, width: 100, height: 0};
    stack.window.fireEvent('scroll');
    stack.driver.tick(48);
    f2.succeed(800, 450); // the completion lands into invalidity
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the withdrawn intent never paints — the baseline stands');

    // Still degenerate, the scene leaves and re-approaches: the
    // withdrawn desire must not re-admit its stale neighbors — an
    // invalid range admits nothing at all.
    const requestsWhileInvalid = stack.images.length;
    scrollTo(stack, scope, 9000);
    stack.driver.tick(80);
    scrollTo(stack, scope, 4000);
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length, requestsWhileInvalid,
        'no stale intent re-admits while the range stays invalid');

    // The range measures again — the retained frame answers the drive.
    scope.rect = {top: -100, bottom: 100, width: 100, height: 200};
    stack.window.fireEvent('scroll');
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'a restored range re-drives and the retained frame commits');
}

// The scheduled pass reads layout for every dirty sequence before any
// of them write: a paint mid-pass never precedes a fresh rectangle or
// computed-style read.
async function passReadsCompleteBeforeWrites() {
    FakeSubscription.reset();
    const order = [];
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const host = new Element('img', 'host');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.src = 'f0.jpg';
    host.setAttribute('data-paste-progressiveresolution', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(host);
    scope.appendChild(scriptJson('frames', {frames: [
        {src: 'f0.jpg', width: 800, height: 450,
            upgrades: [{src: 'f0-2x.jpg', width: 1600, height: 900}]},
        {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
        {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
        {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);

    const realRect = host.getBoundingClientRect.bind(host);
    host.getBoundingClientRect = function () {
        order.push('read:rect');
        return realRect();
    };
    const scopeRect = scope.getBoundingClientRect.bind(scope);
    scope.getBoundingClientRect = function () {
        order.push('read:rect');
        return scopeRect();
    };
    // The module captured getComputedStyle at define; the fixture's
    // computed style reads the host's planted map, so a getter on that
    // map records every computed-style read of the host.
    const plantedStyle = host.computedStyle || {};
    Object.defineProperty(host, 'computedStyle', {
        configurable: true,
        get: function () {
            order.push('read:style');
            return plantedStyle;
        }
    });
    let painted = host.src;
    Object.defineProperty(host, 'src', {
        set: function (value) { order.push('write:src'); painted = value; },
        get: function () { return painted; }
    });
    const realSet = host.style.setProperty.bind(host.style);
    host.style.setProperty = function (name, value, priority) {
        order.push('write:style');
        return realSet(name, value, priority);
    };

    // A pass that commits a freshly landed frame and evaluates an
    // upgrade for it — the reads must all land before the writes.
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    order.length = 0;
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the pass painted the desired frame');
    const firstWrite = order.findIndex(function (entry) {
        return entry.indexOf('write:') === 0;
    });
    const lastRead = order.map(function (entry, index) {
        return entry.indexOf('read:') === 0 ? index : -1;
    }).reduce(function (a, b) { return Math.max(a, b); }, -1);
    assert.ok(firstWrite >= 0, 'the pass wrote');
    assert.ok(order.indexOf('read:style') >= 0, 'the style spy saw no read at all');
    assert.ok(lastRead === -1 || lastRead < firstWrite,
        'no layout read follows a source write: ' + order.join(' → '));
}

// Malformed optional markup stays inert — and invalid: an easing name
// drawn from the Object prototype ('__proto__') must not pass
// validation to throw later inside the shared frame pass. The bad
// declaration leaves its own baseline alone and costs the page's other
// sequences nothing.
async function malformedEasingStaysInertAndNeighborsBind() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const bad = new Element('img', 'bad');
    bad.src = 'b0.jpg';
    bad.setAttribute('data-paste-imagesequence', '#frames-bad');
    bad.setAttribute('data-sequence-intro-duration-ms', '3000');
    bad.setAttribute('data-sequence-intro-easing', '__proto__');
    const good = new Element('img', 'good');
    good.src = 'g0.jpg';
    good.setAttribute('data-paste-imagesequence', '#frames-good');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(bad);
    scope.appendChild(scriptJson('frames-bad', {frames: [
        {src: 'b0.jpg', width: 800, height: 450},
        {src: 'b1.jpg', width: 800, height: 450}
    ]}));
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames-good', {frames: [
        {src: 'g0.jpg', width: 800, height: 450},
        {src: 'g1.jpg', width: 800, height: 450}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(500);
    assert.strictEqual(presented(bad), url('b0.jpg'),
        'the malformed intro leaves its baseline alone');
    assert.ok(stack.images.some(function (image) { return image.src === url('g1.jpg'); }),
        'the malformed host never interrupted the sound sequence');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 1, 'the malformed host is reported once');
    assert.ok(/sequence-intro-easing/.test(reports[0].message), 'the report names the declaration');
}

// A catalog body that is not JSON is a malformed declaration like any
// other: the parse throw must be contained to that host — authored
// baseline stands, nothing is fetched, and a sound neighbor binds
// through the same scan.
async function malformedCatalogJsonStaysInert() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const bad = new Element('img', 'bad');
    bad.src = 'b0.jpg';
    bad.setAttribute('data-paste-imagesequence', '#frames-bad');
    const broken = new Element('script', 'frames-bad');
    broken.setAttribute('type', 'application/json');
    broken.textContent = '{not json';
    const good = new Element('img', 'good');
    good.src = 'g0.jpg';
    good.setAttribute('data-paste-imagesequence', '#frames-good');
    scope.appendChild(bad);
    scope.appendChild(broken);
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames-good', {frames: [
        {src: 'g0.jpg', width: 800, height: 450},
        {src: 'g1.jpg', width: 800, height: 450}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(500);
    assert.strictEqual(presented(bad), url('b0.jpg'),
        'unparseable JSON leaves the authored baseline');
    assert.ok(stack.images.every(function (image) { return image.src === url('g0.jpg') || image.src === url('g1.jpg'); }),
        'the malformed host performed no image work at all');
    assert.ok(stack.images.some(function (image) { return image.src === url('g1.jpg'); }),
        'the malformed catalog never interrupted the sound sequence');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 1, 'the malformed catalog is reported once');
    assert.strictEqual(reports[0].name, 'TypeError', 'a declaration problem is reported as a TypeError');
    assert.ok(reports[0].message.indexOf('paste.ui.imagesequence #bad: ') === 0,
        'the report names the module and the host');
}

// The module header's documented example page, reconstructed verbatim:
// a decorative i.product-visual background host carrying the authored
// stylesheet baseline, a finite intro with its authored skip, the
// reverse scroll range, and per-frame upgrades across subdomains. The
// markup must bind and behave exactly as documented — the example is
// a page, not an illustration.
async function documentedExamplePageBehavesAsAuthored() {
    FakeSubscription.reset();
    const scope = new Element('section', 'product-visual-scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'top bottom');
    scope.setAttribute('data-scrub-end', 'bottom top');
    const visual = new Element('i', 'product-visual');
    visual.setAttribute('data-paste-imagesequence', '#product-frames');
    visual.setAttribute('data-sequence-intro-from', '0');
    visual.setAttribute('data-sequence-intro-to', '2');
    visual.setAttribute('data-sequence-intro-duration-ms', '2400');
    visual.setAttribute('data-sequence-intro-easing', 'ease-in-out');
    visual.setAttribute('data-sequence-intro-skip', '#product-intro-skip');
    visual.setAttribute('data-sequence-from', '2');
    visual.setAttribute('data-sequence-to', '0');
    visual.setAttribute('data-paste-progressiveresolution', '');
    visual.setAttribute('aria-hidden', 'true');
    // The stylesheet's authored baseline — a background has no
    // readiness surface, so the sequence proves the same URL itself.
    visual.computedStyle = {
        'background-image': 'url("/images/product-0-640.webp")',
        'background-size': 'cover'
    };
    const skip = new Element('button', 'product-intro-skip');
    skip.id = 'product-intro-skip';
    skip.setAttribute('type', 'button');
    skip.setAttribute('hidden', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(visual);
    scope.appendChild(skip);
    scope.appendChild(scriptJson('product-frames', {frames: [
        {src: '/images/product-0-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-0-1280.webp',
                width: 1280, height: 1280}]},
        {src: '/images/product-1-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-1-1280.webp',
                width: 1280, height: 1280}]},
        {src: '/images/product-2-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-2-1280.webp',
                width: 1280, height: 1280}]}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    // The adopted baseline is unproven — the intro waits on the proof
    // fetch, and the skip stays hidden until it lands.
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the skip stays authored-hidden until the intro can play');
    const proof = stack.images.filter(function (image) {
        return image.src === 'http://localhost/images/product-0-640.webp';
    })[0];
    assert.ok(proof, 'the unproven baseline proves itself with its own request');
    proof.succeed(640, 640);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the ready trigger reveals the authored skip');
    // The intro plays its declared range; by the time it ends the
    // subject sits mid-range — rect top 300 is progress 0.5, so the
    // reverse range hands catalog index 1 to scroll ownership.
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(3000);
    await settleAll(stack.images, 640, 640);
    stack.driver.tick(3100);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the skip retired with the phase');
    assert.strictEqual(
        visual.style.getPropertyValue('background-image'),
        'url("http://localhost/images/product-1-640.webp")',
        'scroll ownership paints catalog index 1 at range midpoint');
}

// The documented example's second shape: an ordinary meaningful img
// with an explicit data-sequence-scrub reference and absolute frame
// URLs on an image subdomain.
async function documentedImgExampleBinds() {
    FakeSubscription.reset();
    const scope = new Element('section', 'assembly');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'top bottom');
    scope.setAttribute('data-scrub-end', 'bottom top');
    const img = new Element('img', 'assembly-frame');
    img.src = 'https://images-a.example.com/assembly/frame-0-640.webp';
    img.setAttribute('alt', 'The assembly and its opening mechanism');
    img.setAttribute('data-paste-imagesequence', '#assembly-frames');
    img.setAttribute('data-sequence-scrub', '#assembly');
    scope.id = 'assembly';
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(img);
    scope.appendChild(scriptJson('assembly-frames', {frames: [
        {src: 'https://images-a.example.com/assembly/frame-0-640.webp', width: 640, height: 360},
        {src: 'https://images-a.example.com/assembly/frame-1-640.webp', width: 640, height: 360},
        {src: 'https://images-a.example.com/assembly/frame-2-640.webp', width: 640, height: 360}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1800);
    scope.rect = {top: -200, bottom: 0, width: 100, height: 200};
    stack.driver.tick(32);
    await settleAll(stack.images, 640, 360);
    stack.driver.tick(48);
    assert.strictEqual(presented(img),
        'https://images-a.example.com/assembly/frame-2-640.webp',
        'the example binds through its explicit scope reference');
}

// The from-frame's proof fetch is a base completion on the displayed
// index — and a base arrival must never displace a sharper record that
// is already standing. Swapping it in would drop tens of MB from the
// decoded accounting that the display still holds, admitting optional
// work the true footprint cannot afford.
async function lateBaseKeepsTheSharperDisplayedEntry() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    // Authored dimensions pin the layout: every rung paints as src.
    host.setAttribute('width', '800');
    host.setAttribute('height', '450');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, scope, skip} = declaredPage({
        host: host,
        resolution: true,
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 400, height: 800,
                upgrades: [{src: 'up-1600.jpg', width: 1600, height: 3200}]},
            {src: 'f1.jpg', width: 400, height: 800, upgrades: []},
            {src: 'f2.jpg', width: 1800, height: 3600, upgrades: []},
            {src: 'f3.jpg', width: 400, height: 800, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900}
    });
    stack.driver.tick(16);
    // The intro's proof fetch carries the measured tier directly —
    // need ~2000 selects up-1600, never a base-first fetch it would
    // only have to sharpen afterward.
    const proof = stack.images.filter(function (image) {
        return image.src === url('up-1600.jpg');
    })[0];
    const spec = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0];
    assert.ok(proof, 'the intro proves the adopted frame with its selected tier');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'no base-first request ran beneath the selected tier');
    assert.ok(spec, 'the speculative neighbor fills the second slot');
    // The selected rep lands and displays — 1600×3200 ≈ 20.5 MB — and
    // it is itself proof the opening frame exists: decoded pixels of
    // the very frame the intro waits on are readiness.
    proof.succeed(1600, 3200);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('up-1600.jpg'), 'the selected rep displays');
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'a decoded rep of the opening frame is readiness proof');
    stack.driver.tick(40);
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'a landed sharper rep never re-requests the frame base');
    // The accounting still prices the displayed 20.5 MB: scrolled to
    // frame 1 while its fetch is still outstanding — nothing commits
    // — the 1800×3600 (~25.9 MB) member ahead fits the 32 MiB budget
    // only if the displayed pixels were priced at base width.
    scrollFraction(stack, scope, 1050); // progress .25 → desired 1
    stack.driver.tick(48);
    await settlePromises();
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the budget refuses the probe — the standing rep is honestly counted');
    spec.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f1.jpg'), 'the outstanding desire still commits on landing');
}

// The final paint boundary: an entry that never proved its pixels is
// unavailable for presentation — the proven frame keeps standing while
// admission prepares the want. Reversing to a frame whose adopted
// entry is still unproven must not paint it — img host.
async function unprovenEntryCannotReplaceProvenFrameImg() {
    FakeSubscription.reset();
    const img = new Element('img', 'host');
    img.complete = false;
    img.naturalWidth = 0;
    const {stack, scope, host} = declaredPage({host: img});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // progress 0.5 → frame 2
    stack.driver.tick(32);
    // The demand reprioritized the f1 speculation, but its physical
    // request holds its slot until settlement — settle it so the
    // demanded frame can admit.
    const f1 = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0];
    f1.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    const f2 = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(f2, 'the desired frame is demanded');
    f2.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the proven frame paints');
    // Reverse to frame 0: its adopted entry never proved — the paint
    // boundary must refuse it while admission re-asks for the pixels.
    scrollFraction(stack, scope, 0);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'an unproven entry never displaces the proven presentation');
    const f0 = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    });
    assert.ok(f0.length > 0, 'the want re-admits as demanded work');
    // A failed proof preserves the standing presentation.
    f0[f0.length - 1].fail();
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'a failed preparation leaves the proven frame standing');
}

// The same boundary on a background host — the host kind whose paint
// is a stylesheet override, where a wrong commit withdraws the usable
// image underneath.
async function unprovenEntryCannotReplaceProvenFrameBackground() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("f0.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    // The demand reprioritized the f1 speculation, but its physical
    // request holds its slot until settlement — settle it so the
    // demanded frame can admit.
    const f1 = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0];
    f1.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    const f2 = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(f2, 'the desired frame is demanded');
    f2.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f2.jpg') + '")', 'the proven frame paints');
    scrollFraction(stack, scope, 0);
    stack.driver.tick(64);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f2.jpg') + '")',
        'an unproven entry never withdraws the usable image');
    // Reversing the desire deadened the still-unsettled proof — its
    // slot is physical until settlement. Land it (deadened work drops
    // silently), then the freed slot re-admits a fresh demand.
    const f0 = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    });
    assert.ok(f0.length > 0, 'the want re-admits as demanded work');
    f0.forEach(function (image) { image.succeed(800, 450); });
    await settlePromises();
    stack.driver.tick(96);
    const f0fresh = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    });
    if (host.style.getPropertyValue('background-image') !==
            'url("' + url('f0.jpg') + '")') {
        // The landed one was the deadened request — the fresh demand
        // is the newest registry entry for the same URL.
        f0fresh[f0fresh.length - 1].succeed(800, 450);
        await settlePromises();
        stack.driver.tick(128);
    }
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f0.jpg') + '")',
        'a proven entry paints without another input');
}

// Proof of the displayed baseline followed by leave/return: the kept
// entry carries its readiness, so re-entry prepares nothing.
async function provenBaselineIsNotRefetchedOnReturn() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("f0.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(proof, 'a background baseline proves through its own request');
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    // Leave the approaching band through layout alone, then return.
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    const before = stack.images.length;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length - before, 0,
        'a proven displayed representation survives release — nothing re-prepares');
    // The authored baseline is a computed-style presentation the module
    // never overrides — nothing painted over it, nothing withdrew it.
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'the authored baseline still stands');
}

// Proof that lands while the scene sits outside the band still counts:
// readiness is recorded on the displayed state and the kept entry —
// retaining the decoded image is not required to keep the proof.
async function proofLandingOutsideTheBandStillCounts() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("f0.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(proof, 'the proof request is in flight');
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    // The proof settles while the scene is gone — the kept entry and
    // the displayed state still record its arrival.
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    const before = stack.images.length;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length - before, 0,
        'the out-of-band proof held — re-entry prepares nothing');
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'the authored baseline still stands');
}

// A committed upgrade is a proven displayed representation: the flag
// follows the paint, so release and re-entry see ready, not a stale
// unproven marker that re-prepares the base.
async function committedUpgradeKeepsReadinessAcrossReturn() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("f0.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u0.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 800, left: 0, right: 1600, width: 1600, height: 800}
    });
    stack.driver.tick(16);
    const upgrade = stack.images.filter(function (image) {
        return image.src === url('u0.jpg');
    })[0];
    assert.ok(upgrade, 'the proof fetch carries the selected tier');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'no base-first fetch ran beneath the selected tier');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('u0.jpg') + '")', 'the sharper rep paints');
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    const before = stack.images.length;
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length - before, 0,
        'a committed upgrade is proven — re-entry prepares nothing');
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('u0.jpg') + '")', 'the committed rep still stands');
}

// Quoted URL punctuation is legal in an authored background: a frame
// named frame(0).png is a valid resource — the ')' inside quotes is
// content, not the url() terminator. The authored value adopts to its
// declared frame and refines exactly as a plain name does.
async function backgroundUrlKeepsQuotedParentheses() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("frame(0).png")'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'frame(0).png', width: 800, height: 450,
                upgrades: [{src: 'frame(0)-1600.png', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    const refinement = stack.images.filter(function (image) {
        return image.src === url('frame(0)-1600.png');
    })[0];
    assert.ok(refinement,
        'the adopted frame-zero representation refines under static presentation');
    refinement.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('frame(0)-1600.png') + '")',
        'the landed refinement paints the punctuated URL');
}

// A completion for a different representation of the same frame is not
// proof of what is displayed: the sharper rep's readiness stays its own.
async function otherRepCompletionDoesNotProveDisplayed() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("f0.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u0.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 800, left: 0, right: 1600, width: 1600, height: 800}
    });
    stack.driver.tick(16);
    // Only the base proof lands — the upgrade's completion is for a
    // different representation of the same frame and must not mark
    // the displayed base ready where readiness is the question asked.
    const upgrade = stack.images.filter(function (image) {
        return image.src === url('u0.jpg');
    })[0];
    assert.ok(upgrade, 'the upgrade admits beside the proof');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(48);
    // The landed upgrade sharpens what it proved — the paint boundary
    // commits it because ITS entry is ready, never because the index
    // matched something else that happened to load.
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('u0.jpg') + '")',
        'the proven rep — not an index twin — is what commits');
}

// The preferred rung moved mid-flight: 1600 was wanted, a resize made
// 1280 the preference — both are requested, then 1600 lands first and
// 1280 second. "What can improve the paint" is a different question
// from "what should be fetched": the ready cached 1600 commits on its
// own strength, the retained-larger rule keeps it, and after the 1280
// lands nothing re-requests it — the owner goes idle instead of
// looping the same preparation forever.
async function readyCachedRepPaintsWhenThePreferredRungMoves() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        hostRect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500},
        window: {devicePixelRatio: 1},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [
                    {src: 'u1280.jpg', width: 1280, height: 720},
                    {src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const u1600 = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(u1600, 'the wide paint prefers 1600');
    // The f1 speculation holds the second physical slot — land it so
    // the rung change below has capacity to admit.
    stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    // The preferred rung drops: 1280 is admitted beside it.
    host.rect = {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    const u1280 = stack.images.filter(function (image) {
        return image.src === url('u1280.jpg');
    })[0];
    assert.ok(u1280, 'the new preferred rung admits alongside');
    // The larger lands first — its paint stands on its own proof.
    u1600.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the ready cached rep paints though it is not the preferred rung');
    u1280.succeed(1280, 720);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'a smaller same-frame completion never displaces the sharper');
    ['u1280.jpg', 'u1600.jpg'].forEach(function (name) {
        assert.strictEqual(
            stack.images.filter(function (image) {
                return image.src === url(name);
            }).length, 1, name + ' is prepared at most once — no fetch loop');
    });
    // Idle: further passes admit nothing.
    stack.driver.tick(96);
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('u1280.jpg') || image.src === url('u1600.jpg');
        }).length, 2, 'the owner is idle once the cached improvement stands');
}

// Same moving preference, opposite order: the preferred 1280 lands
// first and paints; the already-decoded 1600 then lands and still
// improves — the retained representation is not judged by whether it
// was the rung of the moment.
async function largerCachedRepPaintsAfterTheSmallerPreferred() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        hostRect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500},
        window: {devicePixelRatio: 1},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [
                    {src: 'u1280.jpg', width: 1280, height: 720},
                    {src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    // The f1 speculation holds the second physical slot — land it so
    // the rung change below has capacity to admit.
    stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    host.rect = {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    const u1600 = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    const u1280 = stack.images.filter(function (image) {
        return image.src === url('u1280.jpg');
    })[0];
    assert.ok(u1600 && u1280, 'both rungs are in flight');
    u1280.succeed(1280, 720);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u1280.jpg'), 'the preferred rung paints first');
    u1600.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the larger cached rep still improves the paint');
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('u1280.jpg') || image.src === url('u1600.jpg');
        }).length, 2, 'each URL prepared exactly once');
}

// A failed preferred URL never vetoes a ready cached rep: the
// preference 1280 fails while 1600 sits proven — the 1600 still paints.
async function failedPreferredRungDoesNotVetoCachedImprovement() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        hostRect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500},
        window: {devicePixelRatio: 1},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [
                    {src: 'u1280.jpg', width: 1280, height: 720},
                    {src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    // The f1 speculation holds the second physical slot — land it so
    // the rung change below has capacity to admit.
    stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    host.rect = {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    const u1600 = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    const u1280 = stack.images.filter(function (image) {
        return image.src === url('u1280.jpg');
    })[0];
    assert.ok(u1600 && u1280, 'both rungs are in flight');
    // The preferred fails first — a dead URL is dead work, not a veto.
    u1280.fail();
    await settlePromises();
    u1600.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the ready rep paints although the preferred rung failed');
    stack.driver.tick(64);
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('u1280.jpg');
        }).length, 1, 'the failed URL is not retried');
}

// An authored upgrade URL is itself a catalog representation — exact
// matching adopts it as the displayed rep, whatever the resolution
// opt-in says. The 1600 the page authored is never replaced by the
// 800 base.
function authoredUpgradeIsAdoptedNotDowngraded() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack} = declaredPage({
        host: host,
        baseline: 'u1600.jpg',
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the authored upgrade rep stays — adoption does not downgrade it');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 0, 'the base is not blindly prepared beside its rep');
}

// A background host cannot introspect readiness, so an authored
// upgrade stays unproven — and the proof request targets the
// representation actually displayed, not the frame's base.
async function unprovenAuthoredUpgradeProvesItself() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("u1600.jpg")'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(proof, 'the displayed rep proves itself — not the base');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 0, 'the base was not blindly prepared');
    proof.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 1, 'one proof is enough — nothing re-requests it');
}

// The proof of an adopted optional rep can fail — failure belongs to
// the source URL, not the frame. The healthy base remains preparable.
async function failedAdoptedRepLeavesTheBaseUsable() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("u1600.jpg")'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(proof, 'the adopted rep proves first');
    proof.fail();
    await settlePromises();
    stack.driver.tick(32);
    stack.driver.tick(48);
    const base = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(base, 'a dead optional rep does not poison the healthy base');
    base.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('u1600.jpg');
        }).length, 1, 'the failed rep is not retried');
    assert.strictEqual(
        host.style.getPropertyValue('background-image'),
        'url("' + url('f0.jpg') + '")',
        'the ready base replaces the failed authored source — ' +
        'a narrower honest image beats a broken one');
}

// The same repair for an <img> host: the authored upgrade URL proves
// itself with real pixels, dies, and the base that lands in its place
// paints — resolution enhancement or not, with no further input.
async function failedAdoptedImgRepPaintsTheBase(resolution) {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'u1600.jpg';
    // The authored request is still in flight at bind: unproven, but
    // not failed — nothing may paint over it while that is true.
    host.complete = false;
    const {stack} = declaredPage({
        host: host,
        baseline: null,
        resolution: resolution,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    // The adopted rep is still displayed and demanded — its own proof
    // starts first, and the base is not fetched behind its back while
    // that proof is pending.
    const proof = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(proof, 'the demanded displayed rep proves first');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 0, 'no downgrade while the authored rep is unproven, not failed');
    proof.fail();
    await settlePromises();
    stack.driver.tick(32);
    const base = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(base, 'the failed source drops to the healthy base');
    base.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the landed base paints over the failed source on its own');
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 1, 'the failed rep is not retried');
    assert.strictEqual(stack.driver.pending(), 0, 'the owner is idle once repaired');
}

// A suffix resemblance is not identity: a different poster whose URL
// merely ends with a catalog src — here inside a query string — is
// nobody's frame. Under reduced motion nothing may paint over it.
function suffixResemblanceIsNotAdoption() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.set(true);
    const host = new Element('img', 'host');
    const poster = 'poster.jpg?fallback=' + url('f0.jpg');
    const {stack, scope} = declaredPage({
        host: host,
        baseline: poster,
        resolution: true,
        window: {matchMedia: function () { return motion; }},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url(poster),
        'an unmatched poster stays untouched under reduced motion');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 0, 'no upgrade claims a poster that is not frame zero');
}

// The module's private session key for one declared scene on one
// page — document URL without fragment, the sequence declaration,
// and a stable host discriminator. Tests rebuild it to seed or read
// the record; page, declaration, and host all scope independently.
function introSessionKey(pageHref, declaration, hostId, ordinal) {
    return 'paste-ui-imagesequence-intro|' + pageHref + '|' +
        declaration + '|' + (hostId ? 'id:' + hostId : 'host:' + ordinal);
}

// A back/forward return after the intro ran restores scroll ownership
// directly — however the document is delivered, the once-per-session
// record is the only thing standing between the reader and a replayed
// opening.
async function backForwardReturnSkipsAConsumedIntro() {
    FakeSubscription.reset();
    const store = {};
    store[introSessionKey('http://localhost/', '#frames|3-0|0-3', 'host')] = '1';
    const {stack, scope, host, skip} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {
            sessionStorage: {
                getItem: function (key) { return store[key] === undefined ? null : store[key]; },
                setItem: function (key, value) { store[key] = String(value); }
            },
            performance: {getEntriesByType: function () { return [{type: 'back_forward'}]; }}
        }
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(24);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f3.jpg'), 'the restored scroll position owns the frame');
    assert.strictEqual(skip.getAttribute('hidden'), '', 'a skipped intro never reveals its skip');
    stack.driver.tick(4000);
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f3.jpg'), 'no replay follows the return');
}

// The same return without a recorded intro still plays the opening —
// nothing but the session record suppresses it.
async function backForwardReturnReplaysAnUnconsumedIntro() {
    FakeSubscription.reset();
    const store = {};
    const {stack, scope, host, skip} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {
            sessionStorage: {
                getItem: function (key) { return store[key] === undefined ? null : store[key]; },
                setItem: function (key, value) { store[key] = String(value); }
            },
            performance: {getEntriesByType: function () { return [{type: 'back_forward'}]; }}
        }
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro runs on an unrecorded return');
    assert.strictEqual(
        store[introSessionKey('http://localhost/', '#frames|3-0|0-3', 'host')], '1',
        'starting the intro records it consumed for the session');
}

// A recorded intro only suppresses a back/forward return — an ordinary
// reload is a fresh opening and replays as authored.
async function recordedIntroDoesNotSuppressAnOrdinaryReload() {
    FakeSubscription.reset();
    const store = {};
    store[introSessionKey('http://localhost/', '#frames|3-0|0-3', 'host')] = '1';
    const {stack, scope, host, skip} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {
            sessionStorage: {
                getItem: function (key) { return store[key] === undefined ? null : store[key]; },
                setItem: function (key, value) { store[key] = String(value); }
            },
            performance: {getEntriesByType: function () { return [{type: 'reload'}]; }}
        }
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'a reload still plays the intro');
}

// An adopted representation over the declared cap is only a cache
// record once the demanded frame moves on: speculation prepares the
// frame's eligible base, and the cap-ineligible rep never re-enters
// admission — no settle asks for it again. Cap ineligibility is
// temporary, so nothing records a failure either.
async function overCapAdoptedRepNeverLoopsAsNeighbor() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {
        'background-image': 'url("u1600.jpg")',
        '--paste-resolution-max-width': '800'
    };
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        // Bound at the far end, then scrolled back to mid-range: the
        // reversal points the lookahead backward, so the adopted u1600
        // at index 0 sits inside the window as speculation — never
        // the demanded still-displayed proof.
        scopeRect: {top: -200, bottom: 0, width: 100, height: 200},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1100); // reverse to desired 1 — the lead points back
    stack.driver.tick(24);
    const u1600s = function () {
        return stack.images.filter(function (image) {
            return image.src === url('u1600.jpg');
        }).length;
    };
    assert.strictEqual(u1600s(), 0,
        'a speculative neighbor prepares the eligible base, not the ' +
        'cap-ineligible adopted rep');
    const f1 = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    })[0];
    const f0 = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(f1, 'the demanded frame prepared');
    assert.ok(f0, 'the eligible neighbor base prepared');
    // Frame 1 lands and paints first — the order in which a discarded
    // u1600 entry must not re-request itself.
    f1.succeed(800, 450);
    f0.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('f1.jpg') + '")', 'the demanded frame painted');
    // Drain whatever the settle woke: three passes with no input —
    // a re-request loop would keep minting u1600 loads.
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.strictEqual(u1600s(), 0, 'the cap-ineligible rep was never re-requested');
    assert.strictEqual(stack.driver.pending(), 0, 'the owner went idle');
}

// An authored rep the current cap refuses is no proof to wait on:
// admission prepares the selected representation directly while the
// authored presentation keeps standing. Fetching the ineligible rep
// first would only postpone the eligible source behind pixels that can
// never paint — and cap exclusion is not a source failure, so the URL
// records nothing.
async function capIneligibleDisplayedRepDoesNotRedirectAdmission() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {
        'background-image': 'url("u1600.jpg")',
        '--paste-resolution-max-width': '800'
    };
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const first = stack.images[0];
    assert.strictEqual(presented(first), url('f0.jpg'),
        'the selected rep is the first preparation — not the cap-refused authored one');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 0, 'the cap-ineligible authored rep is never a module request');
    first.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 0, 'the ineligible rep never enters later admission either');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1, 'the selected rep is not re-requested');
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'the authored presentation stands while the eligible rep waits');
    assert.strictEqual(stack.driver.pending(), 0, 'the owner went idle');
}

// Optional admission prices the representation actually requested:
// with an unproven authored upgrade parked at a neighbor index and
// demanded work outstanding, the neighbor that enters admission is the
// frame's eligible base — the oversized rep is never what the budget
// check is asked about, and it is never what gets fetched.
async function optionalAdmissionPricesTheRequestedRep() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("u3200.jpg")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        // No cap declaration — automatic policy — so nothing about a
        // cap refusal can explain the answer; only honest admission
        // accounting can. Bound at the far end, then scrolled back so
        // the reversal's window reaches index 0 as speculation.
        scopeRect: {top: -200, bottom: 0, width: 100, height: 200},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u3200.jpg', width: 3200, height: 1800}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1100); // reverse to desired 1 — index 0 trails the lead
    stack.driver.tick(24);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u3200.jpg');
    }).length, 0, 'the oversized adopted rep never enters optional admission');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the neighbor admitted is the frame base');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the demanded frame prepared');
    await settleAll(stack.images);
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u3200.jpg');
    }).length, 0, 'no late admission of the oversized rep either');
    assert.strictEqual(stack.driver.pending(), 0, 'the owner went idle');
}

// Two documents on one origin can reuse a host id freely — the
// session record is scoped to the page's own URL, so one page's
// consumed intro never suppresses another's.
async function introRecordStaysScopedToItsPage() {
    FakeSubscription.reset();
    const store = {};
    const session = {
        getItem: function (key) { return store[key] === undefined ? null : store[key]; },
        setItem: function (key, value) { store[key] = String(value); }
    };
    const page = function (href, navigationType) {
        return declaredPage({
            sequenceFrom: 3, sequenceTo: 0,
            intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
            skipId: 'skip',
            window: {
                location: {href: href},
                sessionStorage: session,
                performance: {
                    getEntriesByType: function () { return [{type: navigationType}]; }
                }
            }
        });
    };
    const declaration = '#frames|3-0|0-3';
    // Page A's first visit plays the intro and records it consumed.
    const a = page('http://localhost/a', 'navigate');
    a.stack.driver.tick(100);
    await settleAll(a.stack.images);
    a.stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(
        store[introSessionKey('http://localhost/a', declaration, 'host')], '1',
        'page A recorded its own intro');
    // A history return to page B — same host id, different document —
    // finds no record of its own and plays its intro.
    const b = page('http://localhost/b', 'back_forward');
    b.stack.driver.tick(100);
    await settleAll(b.stack.images);
    b.stack.driver.tick(116);
    assert.strictEqual(b.skip.hasAttribute('hidden'), false,
        'page B\'s intro runs — A\'s record does not reach across documents');
    // And the return to A restores scroll ownership under A's own key.
    const a2 = page('http://localhost/a', 'back_forward');
    a2.stack.driver.tick(100);
    await settleAll(a2.stack.images);
    a2.stack.driver.tick(116);
    await settleAll(a2.stack.images);
    assert.strictEqual(a2.host.src, url('f3.jpg'),
        'page A\'s own record restores scroll ownership on return');
    assert.strictEqual(a2.skip.hasAttribute('hidden'), true,
        'page A\'s intro does not replay');
}

// A host without an id is still a stable scene: its discriminator is
// its ordinal among the document's declared hosts — deterministic
// across reloads of the same markup, no author-facing id required.
async function idLessHostRecordsByOrdinal() {
    FakeSubscription.reset();
    const store = {};
    const session = {
        getItem: function (key) { return store[key] === undefined ? null : store[key]; },
        setItem: function (key, value) { store[key] = String(value); }
    };
    const page = function (navigationType) {
        return declaredPage({
            host: new Element('img'),
            sequenceFrom: 3, sequenceTo: 0,
            intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
            skipId: 'skip',
            window: {
                sessionStorage: session,
                performance: {
                    getEntriesByType: function () { return [{type: navigationType}]; }
                }
            }
        });
    };
    const first = page('navigate');
    first.stack.driver.tick(100);
    await settleAll(first.stack.images);
    first.stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(
        store[introSessionKey('http://localhost/', '#frames|3-0|0-3', null, 0)], '1',
        'the id-less host recorded under its declaration ordinal');
    const second = page('back_forward');
    second.stack.driver.tick(100);
    await settleAll(second.stack.images);
    second.stack.driver.tick(116);
    await settleAll(second.stack.images);
    assert.strictEqual(presented(second.host), url('f3.jpg'),
        'the same markup reloads the same key — scroll ownership restored');
    assert.strictEqual(second.skip.hasAttribute('hidden'), true,
        'the id-less intro does not replay');
}

// One page can declare several intros — each host's record stands on
// its own key, so the consumed one suppresses only itself.
async function siblingIntrosRecordIndependently() {
    FakeSubscription.reset();
    const store = {};
    const session = {
        getItem: function (key) { return store[key] === undefined ? null : store[key]; },
        setItem: function (key, value) { store[key] = String(value); }
    };
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const hostA = new Element('img', 'hero-a');
    hostA.setAttribute('data-paste-imagesequence', '#frames-a');
    hostA.src = 'f0.jpg';
    hostA.setAttribute('data-sequence-from', '3');
    hostA.setAttribute('data-sequence-to', '0');
    hostA.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostA.setAttribute('data-sequence-intro-easing', 'linear');
    hostA.setAttribute('data-sequence-intro-skip', '#skip-a');
    const hostB = new Element('img', 'hero-b');
    hostB.setAttribute('data-paste-imagesequence', '#frames-b');
    hostB.src = 'f0.jpg';
    hostB.setAttribute('data-sequence-from', '3');
    hostB.setAttribute('data-sequence-to', '0');
    hostB.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostB.setAttribute('data-sequence-intro-easing', 'linear');
    hostB.setAttribute('data-sequence-intro-skip', '#skip-b');
    const skipA = new Element('button', 'skip-a');
    skipA.setAttribute('type', 'button');
    skipA.setAttribute('hidden', '');
    const skipB = new Element('button', 'skip-b');
    skipB.setAttribute('type', 'button');
    skipB.setAttribute('hidden', '');
    scope.appendChild(hostA);
    scope.appendChild(scriptJson('frames-a', catalog(4)));
    scope.appendChild(skipA);
    scope.appendChild(hostB);
    scope.appendChild(scriptJson('frames-b', catalog(4)));
    scope.appendChild(skipB);
    // A's intro already ran on a previous visit; B's never did. Same
    // page, same history return — only A's record exists.
    store[introSessionKey('http://localhost/', '#frames-a|3-0|0-3', 'hero-a')] = '1';
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: false,
        imagesequence: true,
        window: {
            sessionStorage: session,
            performance: {
                getEntriesByType: function () { return [{type: 'back_forward'}]; }
            }
        }
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    await settleAll(stack.images);
    assert.strictEqual(skipA.hasAttribute('hidden'), true,
        'A\'s recorded intro stays consumed');
    assert.strictEqual(skipB.hasAttribute('hidden'), false,
        'B\'s unrecorded intro still plays');
}

// Storage can deny reads and writes outright — private windows, quota,
// disabled storage. The intro contract then degrades to "no record",
// which means it plays — never to a broken page.
async function unavailableSessionStorageStillPlays() {
    FakeSubscription.reset();
    const denied = {
        getItem: function () { throw new Error('denied'); },
        setItem: function () { throw new Error('denied'); },
        removeItem: function () { throw new Error('denied'); }
    };
    const {stack, skip} = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {sessionStorage: denied}
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'a denied store never blocks the opening');
    // And a history return on the same denied store still plays — the
    // read failure reads as "unconsumed", which is the honest answer.
    const again = declaredPage({
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {
            sessionStorage: denied,
            performance: {
                getEntriesByType: function () { return [{type: 'back_forward'}]; }
            }
        }
    });
    again.stack.driver.tick(100);
    await settleAll(again.stack.images);
    again.stack.driver.tick(116); // the parked proof reconciles — clock starts here
    assert.strictEqual(again.skip.hasAttribute('hidden'), false,
        'unavailable storage replays rather than crashing or guessing');
}

// A scroll that lands while the intro still waits on its opening frame
// owns the scene outright: progress may stay clamped at the start, but
// the root offset moved — and a moved offset is the user's position.
// The wait's baseline is captured when the wait begins; the pass
// snapshots the live offset in its read phase and ends the phase
// rather than letting a late proof start a run the user already left.
async function scrollBeforeIntroProofPreventsTheIntro() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        baseline: null,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16); // the wait begins; f0's proof is in flight
    scrollTo(stack, scope, 300); // the offset moves — progress stays clamped 0
    stack.images.forEach(function (image) { image.succeed(800, 450); });
    await settlePromises();
    // One pass sees the settled proof and the moved offset together —
    // the scroll wins before the intro can activate at all.
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a scroll before proof never exposes the skip');
    stack.images.forEach(function (image) {
        if (image.src === url('f3.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'the scroll-owned frame paints instead of the intro');
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f3.jpg'), 'no intro loop ever ran');
    assert.strictEqual(skip.hasAttribute('hidden'), true);
}

// The same race with the events reversed: the proof lands first, the
// scroll follows — both settle before the next scheduled pass.
async function proofThenScrollBeforeOnePassPreventsTheIntro() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        baseline: null,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 450); });
    scrollTo(stack, scope, 300);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a scroll inside the same window still wins');
    stack.images.forEach(function (image) {
        if (image.src === url('f3.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f3.jpg'));
    stack.driver.tick(4000);
    assert.strictEqual(presented(host), url('f3.jpg'), 'no intro loop ever ran');
    assert.strictEqual(skip.hasAttribute('hidden'), true);
}

// A scroll that lands before the very first scheduled pass is the
// user's position at the wait's start — the wait never forms, and the
// intro's opening frame is never even asked for.
async function scrollBeforeTheFirstPassPreventsTheIntro() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        baseline: null,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    scrollTo(stack, scope, 300);
    stack.driver.tick(16);
    // The intro's claim is its clock and skip control — a reversed
    // lookahead may legitimately fetch the opening frame as
    // speculation; it is not the intro activating.
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a scrolled start is scroll-owned from the first pass');
    stack.images.forEach(function (image) {
        if (image.src === url('f3.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f3.jpg'));
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true);
}

// The same handoff on a nested root: the scroller's own offset is the
// position, and an overscroll that leaves progress clamped at the
// start is still the user's position — the intro never activates.
async function nestedRootScrollBeforeProofPreventsTheIntro() {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.clientHeight = 400;
    scroller.scrollHeight = 1600;
    scroller.scrollTop = 0;
    const {stack, host, skip} = declaredPage({
        baseline: null,
        scroller: scroller,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    scroller.scrollTop = -40; // overscroll: the offset moved, progress clamps 0
    scroller.fireEvent('scroll');
    stack.images.forEach(function (image) { image.succeed(800, 450); });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a moved nested offset ends the wait exactly like the window\'s');
    stack.images.forEach(function (image) {
        if (image.src === url('f3.jpg')) {
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'the scroller\'s declared start frame owns the paint');
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true);
}

// The control: nothing scrolled, so the proven opening frame starts
// the intro exactly as declared — the gate only fires on real movement.
async function noScrollStillStartsTheIntro() {
    FakeSubscription.reset();
    const {stack, host, skip} = declaredPage({
        baseline: null,
        sequenceFrom: 3, sequenceTo: 0,
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 450); });
    await settlePromises();
    stack.driver.tick(100);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'an unmoved position lets the intro expose its skip');
    await settleAll(stack.images);
    stack.driver.tick(1700); // elapsed 1600 → progress .53 → index 1
    await settleAll(stack.images);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the intro clock advances the playhead as authored');
}

// The request carries the measured representation: with a painted
// width that wants the 1600 rung, every request — the desired frame
// and the prepared members of its window alike — asks for that tier
// directly. Nothing requests the frame base first merely to sharpen
// it afterward.
async function selectedTierIsTheRequestNotTheBase() {
    FakeSubscription.reset();
    const {stack} = declaredPage({
        resolution: true,
        upgrades: [{src: 'u-1600.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 800, left: 0, right: 1200, width: 1200, height: 800}
    });
    stack.driver.tick(16);
    assert.ok(stack.images.length > 0, 'the window prepared');
    assert.ok(stack.images.every(function (image) {
        return image.src === url('u-1600.jpg');
    }), 'every request carries the measured tier — no base-first fetch ran');
}

// The retained cache fills to just under the decoded budget with base
// frames — a shape that must not stop sharpening and neighbor
// preparation. Once outstanding work settles, admission itself
// reclaims the obsolete members and the live window resumes — no
// further user input required.
async function fullCacheReclaimResumesPreparation() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        catalogDocument: {frames: Array.from({length: 40}, function (_, index) {
            // ~1.3 MB decoded each — about 26 of them fill the budget,
            // all base representations with nothing else to ask for.
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    let clock = 16;
    const succeedAll = async function () {
        for (let round = 0; round < 6; round += 1) {
            stack.images.forEach(function (image) {
                if (!image.settled) {
                    image.settled = true;
                    image.succeed(400, 800);
                }
            });
            await settlePromises();
            stack.driver.tick(clock += 16);
        }
    };
    stack.driver.tick(clock);
    // March forward — each landing commits and retains until the
    // cache is full of frames the window has already passed. The
    // offsets land desired 6, 12, 18, 24, 30 of 39.
    [954, 1108, 1262, 1415, 1569].forEach(function (offset) {
        scrollFraction(stack, scope, offset);
        stack.driver.tick(clock += 16);
    });
    const beforeSettles = stack.images.length;
    // No further input at all: every settle's own pass reclaims the
    // members the window left behind and preparation continues into
    // the lead — the full cache is work to drop, not a dead end.
    await succeedAll();
    assert.ok(stack.images.length > beforeSettles,
        'preparation resumed on settle alone — reclaim opened room for the live window');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f31.jpg');
    }), 'the member ahead of the desire fetched once room was reclaimed');
    await succeedAll();
    assert.strictEqual(stack.driver.pending(), 0, 'the owner went idle — no admit-evict-refetch loop');
}

// The window is the direction of travel, not a radius: bound
// mid-catalog, the lead prepares what motion is coming to and never
// touches what it already passed. Reversing recomputes the lead —
// the frames behind become the lead and the dropped tail members
// hold their physical slots until they settle.
async function lookaheadLeadsTheDirectionOfTravel() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        // progress ~0.27 → desired 3 of 12 at bind
        scopeRect: {top: 527, bottom: 727, width: 100, height: 200},
        catalogDocument: {frames: Array.from({length: 12}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    [0, 1, 2].forEach(function (index) {
        assert.ok(!stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' behind the lead is never prepared');
    });
    [3, 4, 5].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' in the direction of travel prepares');
    });
    [9, 10, 11].forEach(function (index) {
        assert.ok(!stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' past the slot bound still waits');
    });

    scrollFraction(stack, scope, 982); // progress ~0.18 → desired 2: reversal
    stack.driver.tick(32);
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the reversed demand waits — obsolete lead members hold their slots');
    stack.images.forEach(function (image) {
        if (!image.settled) {
            image.settled = true;
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the reversal recomputes the lead once slots settle');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the member the reversal now leads to prepares');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the baseline inside the window owes its decode proof like any member');
}

// The intro's lead is the declared easing, not a frame count: an
// ease-in-out clock asks for the index the easing reaches inside the
// horizon — one frame at the slow start, the eased span once the
// clock is moving — and every member of that lead is demanded work.
async function introLeadFollowsTheEasedHorizon() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack} = declaredPage({
        host: host,
        document: {readyState: 'interactive'},
        intro: {from: 0, to: 11, durationMs: 3000, easing: 'ease-in-out'},
        catalogDocument: {frames: Array.from({length: 12}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg'), url('f1.jpg')],
        'the wait proves its opening frame, then the one-frame eased lead');
    stack.images[0].succeed(400, 800);
    await settlePromises();
    stack.driver.tick(48); // the clock starts; elapsed ~0
    // ease-in-out at elapsed+500ms reaches barely past the opening —
    // the demanded lead is the eased index, not a fixed count.
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('f0.jpg'), url('f1.jpg')].sort(),
        'the slow easing start asks for a one-frame lead');
    stack.driver.tick(1048); // elapsed ~1000 → desire 2, horizon index ~6
    [2, 3, 4, 5, 6].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' inside the eased horizon is demanded');
    });
    [9, 10, 11].forEach(function (index) {
        assert.ok(!stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' beyond the eased horizon never demanded');
    });
}

// A displayed-frame upgrade outranks the speculative window when the
// decoded budget is full. The scene: nine retained
// 864×864 representations — 26,873,856 bytes — and a resize selects
// 1296, adding 6,718,464 against a 33,554,432 budget — over by only
// 37,888 bytes. Every retained member sits inside the live window, so
// nothing may starve the replacement: the farthest speculation is
// reclaimed, the 1296 request starts with no further input, and the
// 864 paint stands until it lands.
async function displayedUpgradeReclaimsTheSpeculativeWindow() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    // Authored dimensions pin the layout: every rung paints as src.
    host.setAttribute('width', '800');
    host.setAttribute('height', '450');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        resolution: true,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 12}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 540, height: 540,
                upgrades: [
                    {src: 'u864-' + index + '.jpg', width: 864, height: 864},
                    {src: 'u1296-' + index + '.jpg', width: 1296, height: 1296}
                ]
            };
        })}
    });
    stack.driver.tick(16);
    // desired 0 — the window {0..7} prepares at the selected 864 tier.
    // progress .2 → desired 2 — the window slides to {2..10}: eleven
    // retained 864 representations, 32.85 MB. Two sit outside the
    // live window; the other nine are all window members — the
    // pressure under which every candidate victim is protected.
    scrollFraction(stack, scope, 1000);
    stack.driver.tick(32);
    for (let round = 0; round < 4; round += 1) {
        stack.images.forEach(function (image) {
            if (!image.settled) {
                image.settled = true;
                image.succeed(864, 864);
            }
        });
        await settlePromises();
        stack.driver.tick(32 + round * 16);
    }
    assert.strictEqual(presented(host), url('u864-2.jpg'),
        'the desired frame committed at the selected 864 tier');
    // The box grows — the pass re-measures, selects 1296, and the
    // upgrade must make its own room: obsolete entries first, then the
    // farthest speculation still inside the window.
    host.rect = {top: 0, bottom: 1200, left: 0, right: 1200, width: 1200, height: 1200};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    const upgrade1296 = stack.images.filter(function (image) {
        return image.src === url('u1296-2.jpg');
    })[0];
    assert.ok(upgrade1296,
        'the 1296 replacement started — window membership never starves the displayed frame');
    assert.strictEqual(presented(host), url('u864-2.jpg'),
        'the standing image stands until the replacement proves');
    upgrade1296.succeed(1296, 1296);
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('u1296-2.jpg'),
        'the sharper rep commits once it lands');
    // No admit–evict–refetch churn: the owner settles to idle.
    await settleAll(stack.images, 864, 864);
    stack.driver.tick(128);
    stack.driver.tick(144);
    assert.strictEqual(stack.driver.pending(), 0,
        'the owner went idle — no evict–refetch loop');
}

// The intro's startup buffer is authored in time: a 120-frame,
// three-second ease-in-out intro traverses indices 0–6 inside its
// first 500 ms, so a declared 500 ms buffer demands exactly that set
// before the clock starts — the opening frame alone is not enough.
async function introBufferHoldsTheClockUntilTheSetIsReady() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, skip} = declaredPage({
        host: host,
        baseline: null,
        skipId: 'skip',
        intro: {from: 0, to: 119, durationMs: 3000, easing: 'ease-in-out',
            bufferMs: 500, skip: '#skip'},
        catalogDocument: {frames: Array.from({length: 120}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const wanted = [0, 1, 2, 3, 4, 5, 6];
    // The whole authored set is demand — the slot bound is the only
    // reason a member still waits.
    stack.images.forEach(function (image) {
        const match = /f(\d+)\.jpg/.exec(image.src);
        assert.ok(match && wanted.indexOf(Number(match[1])) >= 0,
            image.src + ' — only authored-lead members were demanded');
    });
    assert.strictEqual(stack.images.length, 6,
        'the slot bound caps the demanded set in flight');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the clock holds while the authored set prepares');
    // The opening frame alone must not start the clock — the exact
    // first-frame-only behavior this buffer replaces — and its settle
    // admits the seventh member.
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f6.jpg');
    }), 'the freed slot admits the last required member');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the opening frame alone does not release the clock');
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the full authored set ready starts the clock');
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the opening frame painted with the start');
}

// The startup wait is bounded: the authored set may never arrive, so
// the wait carries one deadline — when it expires the intro is
// abandoned once, the baseline keeps standing, and the live scroll
// owns the presentation from then on.
async function introBufferDeadlineAbandonsTheWaitOnce() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, scope, skip} = declaredPage({
        host: host,
        baseline: null,
        skipId: 'skip',
        window: {
            setTimeout: function (fn, ms) {
                timers.push({fn: fn, ms: ms});
                return timers.length;
            },
            clearTimeout: function () {}
        },
        intro: {from: 0, to: 119, durationMs: 3000, easing: 'ease-in-out',
            bufferMs: 500, skip: '#skip'},
        catalogDocument: {frames: Array.from({length: 120}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.strictEqual(timers.length, 1, 'the wait armed its bound once');
    assert.strictEqual(timers[0].ms, 15000, 'the bound is the internal deadline');
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'still waiting');
    // The deadline expires with the set still outstanding: the wait
    // ends on its own and ordinary driving takes over.
    timers[0].fn();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the abandoned wait never showed a skip');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 60
    stack.driver.tick(48);
    // The abandoned wait's outstanding fetches settle, their slots
    // free, and the live desire admits next pass.
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(64);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f60.jpg'),
        'the live scroll position owns the presentation after the abandon');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the intro never replays behind the user');
}

// The bound is one absolute deadline on the frame clock, not one full
// interval per measurable spell: measurable → zero-size → measurable
// disarms the pending wake but keeps the recorded bound, so a host
// restored late in the window arms only what remains — and repeated
// churn still ends at the same single instant.
async function unmeasurableIntervalsKeepOneDeadline() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) { timer.live = false; }
            }
        },
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(0); // first eligible pass — bound records t=15000
    assert.strictEqual(timers.length, 1, 'the first eligible pass armed');
    assert.strictEqual(timers[0].ms, 15000, 'the bound is the full wait');

    // Losing the surface disarms the wake — the bound it counted
    // toward stays recorded.
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(100);
    assert.strictEqual(timers[0].live, false, 'the pending wake disarmed');
    assert.strictEqual(timers.length, 1, 'no timer while unmeasurable');

    // Restored mid-window: the same bound keeps running — never a
    // fresh 15000ms.
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(7400);
    assert.strictEqual(timers.length, 2, 're-eligibility re-arms once');
    assert.strictEqual(timers[1].ms, 7600,
        'the re-arm is the remainder of one bound — got ' + timers[1].ms);

    // Churn again — the second disarm changes nothing about the end.
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(7500);
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(14900);
    assert.strictEqual(timers.length, 3, 'the second restore re-arms once');
    assert.strictEqual(timers[2].ms, 100,
        'churn cannot buy a second bound — got ' + timers[2].ms);

    // The wake that lands is the same single bound's: the wait is
    // over once, and no later timer exists to extend it.
    timers[2].fn();
    stack.driver.tick(15000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the abandoned wait never showed a skip');
    assert.ok(timers.every(function (timer) { return !timer.live || timer === timers[2]; }),
        'a live timer outlived the bound it counted');
}

// A wake that survives its own disarm is inert: firing a cancelled
// timer must not retire a wait a later arm still owns.
async function staleIntroWakeCannotRetireALiveWait() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) { timer.live = false; }
            }
        },
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(0); // bound records; wake one arms
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(100); // the first wake disarms
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(200); // a later wake now owns the same bound
    assert.strictEqual(timers.length, 2);

    // The retired wake fires anyway — a clearTimeout that only marked
    // it dead. Its callback must prove identity before acting.
    timers[0].fn();
    await settleAll(stack.images, 400, 800);
    stack.driver.tick(300);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'a stale wake retired the wait its successor still owned');
}

// Restoration after the bound passed ends the wait on arrival: no
// timer, no intro — the live scroll position owns the presentation
// immediately, exactly as if the deadline had fired while inactive.
async function restoreAfterDeadlineExpiryHandsToScroll() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    const {stack, scope, host: hostEl, skip} = declaredPage({
        host: host,
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) { timer.live = false; }
            }
        },
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(0); // bound records t=15000, wake arms
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(100);
    // The bound passed while the host could not paint — restoring now
    // is not a second trial: the wait ends and the scroll owns.
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(16000);
    assert.strictEqual(timers.length, 1,
        'a new timer armed past the bound — the wait restarted');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'an expired wait still revealed its skip');

    // Scroll ownership is immediate: the live position drives as an
    // undeclared intro would — the desired frame prepares, lands,
    // paints.
    scrollFraction(stack, scope, 1800); // progress 1 → desired f9
    stack.driver.tick(16100);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(16200);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(16300);
    assert.strictEqual(presented(hostEl), url('f9.jpg'),
        'the live scroll position did not take over after expiry');
}

// A startup buffer the decoded budget can never hold is infeasible —
// the authored threshold is never silently lowered: the intro is
// abandoned once at the first eligible pass, nothing demanded starts,
// and scrolling behaves exactly as an undeclared intro would.
async function infeasibleIntroBufferAbandonsTheIntro() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack, scope, skip} = declaredPage({
        host: host,
        baseline: null,
        skipId: 'skip',
        document: {readyState: 'interactive'},
        intro: {from: 0, to: 119, durationMs: 3000, easing: 'ease-in-out',
            bufferMs: 500, skip: '#skip'},
        catalogDocument: {frames: Array.from({length: 120}, function (_, index) {
            // 1600×1200 ≈ 7.7 MB decoded — seven of them cannot
            // coexist inside the ~32 MiB budget beside the poster.
            return {src: 'f' + index + '.jpg', width: 1600, height: 1200, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the infeasible set abandons the wait before any clock');
    // The abandoned intro demanded no seven-member set — the scroll
    // position's own desire admits first, and only the ordinary
    // lookahead the budget holds follows it.
    assert.strictEqual(stack.images[0].src, url('f0.jpg'), 'the live desire admits first');
    assert.ok(stack.images.length <= 4,
        'the buffer set was demanded: ' + stack.images.length + ' requests');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 60
    stack.driver.tick(32);
    // The lookahead already in flight keeps its room until it lands.
    for (let round = 0; round < 3; round += 1) {
        await settleAll(stack.images, 1600, 1200);
        stack.driver.tick(33 + round);
    }
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f60.jpg'),
        'scroll ownership paints the live desire');
}

// The authored scrub gate: with three declared, a frame change waits
// on the desired index and the two behind it in the direction of
// travel — the standing image stands while the set funds, never
// replaying a backlog; once open the gate paints each ready desire
// and closes again on a miss.
async function scrubBufferGatesChangesUntilTheSetIsReady() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // progress .16 → desired 1 of 10 — the adopted baseline is index 0
    // and the gate wants {1,2,3} before the first change.
    scrollFraction(stack, scope, 960);
    stack.driver.tick(32);
    [1, 2, 3].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' is demanded as a required member');
    });
    // Desired alone is not enough — the gate stays closed.
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the standing image stands while the set is short');
    // Only the required members land — the gate opens on the full set.
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg') || image.src === url('f3.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the full set ready commits the desired frame');
    // The miss: desired 4 was only ever speculation — the gate closes
    // and wants {4,5,6} together before the change.
    scrollFraction(stack, scope, 1250); // progress .45 → desired 4
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the missed desire closes the gate — the last paint stands');
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f4.jpg'),
        'the funded set opens the gate and commits');
    // Endpoint clipping: desired 9 can only ever want {9} — two
    // following frames do not exist, and the gate does not wait on
    // the impossible third.
    scrollFraction(stack, scope, 1800); // progress 1 → desired 9
    stack.driver.tick(112);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(128);
    assert.strictEqual(presented(host), url('f9.jpg'),
        'the endpoint-clipped set still opens the gate');
}

// Authored 3, two remaining — desired 8's set is {8,9}, not an
// impossible third past the endpoint. Both ready means the gate opens;
// an implementation that demanded the full authored count here would
// wait forever.
async function scrubBufferClampsToTheEndpoint() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1600); // progress .8 → desired 8
    stack.driver.tick(32);
    // The bind-time speculation still holds the slots — the required
    // pair admits as it frees, then settles.
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (!image.settled) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f8.jpg'),
        'two remaining frames satisfy the authored three at the endpoint');
}

// Direction change reopens the gate on the new set, not the old:
// closed on {5,6,7} going forward, a scroll back to 2 wants {2,1,0} —
// the members already prepared there release the gate without the
// abandoned forward set ever landing.
async function scrubGateReopensOnDirectionChange() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // Prepare the low frames first — index 0 is the adopted baseline
    // and still owes its decode proof; all three required members land.
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg') || image.src === url('f1.jpg') ||
                image.src === url('f2.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    // Scroll forward to 6 — a miss: the gate closes on {6,7,8}.
    scrollFraction(stack, scope, 1400); // progress .6 → desired 6
    stack.driver.tick(48);
    // The missed desire never repaints — and the gate's own open pass
    // refused to repaint the standing frame with its own tier: the
    // authored baseline stands literally as authored.
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the missed forward desire holds the authored baseline');
    // Reverse to 2 without ever settling the forward set — the
    // backward set {2,1,0} is already prepared and opens the gate.
    scrollFraction(stack, scope, 1050); // progress .25 → desired 2
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the reversed direction recomputes the required set');
    // The abandoned forward member never landed — proof the reopened
    // gate did not wait on the old set.
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f6.jpg') && image.settled;
    }), 'the abandoned forward set was never required');
}

// A required set whose member can never arrive — every representation
// dead — is remembered rather than retried: admissions for that set
// stop, the standing image stands, and a genuinely changed desire
// evaluates on its own terms.
async function deadRequiredMemberDeniesTheSetOnce() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 960); // desired 1 — required {1,2,3}
    stack.driver.tick(32);
    // f2 dies outright; f1 and f3 land.
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.fail();
        } else {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'a set that can never fund never gates open');
    const before = stack.images.length;
    stack.driver.tick(64);
    stack.driver.tick(80);
    assert.strictEqual(stack.images.length, before,
        'the denied set is remembered — no refetch churn for the dead member');
    // A changed desire is a different set: it evaluates fresh and its
    // own members admit.
    scrollFraction(stack, scope, 1800); // progress 1 → desired 9 — {9}
    stack.driver.tick(96);
    stack.images.forEach(function (image) {
        if (!image.settled && image.src !== url('f2.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('f9.jpg'),
        'a changed set evaluates on its own terms');
}

// An invalid buffer declaration is a bad declaration — the host keeps
// its authored baseline and binds nothing at all.
async function invalidBufferDeclarationsStayInert() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const host = new Element('img', 'host');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.src = 'f0.jpg';
    host.setAttribute('data-sequence-scrub-buffer-frames', '2.5');
    scope.appendChild(host);
    scope.appendChild(scriptJson('frames', catalog(4)));
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const stack = openStack({elements: {scope: scope}, imagesequence: true});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a fractional frame count binds nothing');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline stands');
}

// Failure fallback reaches the displayed frame's sharpening too: the
// preferred rung dead, the best surviving rung below it is fetched —
// the upgrade path uses the same failure-aware selection the request
// path does, and a dead URL is never retried.
async function failedPreferredUpgradeFallsBackToSurvivingRung() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [
            {src: 'u-960.jpg', width: 960, height: 540},
            {src: 'u-1280.jpg', width: 1280, height: 720}
        ],
        hostRect: {top: 0, bottom: 450, left: 0, right: 1200, width: 1200, height: 450}
    });
    stack.driver.tick(16);
    // need ~1200 selects the 1280 rung — the upgrade fetch for the
    // displayed frame 0. The sibling frames carry the same upgrade
    // URLs, so the rung may already sit on other frames' requests —
    // what matters is nothing *new* asks for it after it fails.
    const preferred = stack.images.filter(function (image) {
        return image.src === url('u-1280.jpg');
    })[0];
    const preferredCount = stack.images.filter(function (image) {
        return image.src === url('u-1280.jpg');
    }).length;
    assert.ok(preferred, 'the preferred rung requested first');
    preferred.fail();
    await settlePromises();
    stack.driver.tick(32);
    const surviving = stack.images.filter(function (image) {
        return image.src === url('u-960.jpg');
    });
    assert.ok(surviving.length >= 1,
        'the surviving rung below the dead one is fetched next');
    surviving.forEach(function (image) { image.succeed(960, 540); });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u-960.jpg'),
        'the surviving rung commits over the displayed base');
    // A later re-evaluation never retries the dead URL — the preferred
    // rung's request count stays exactly where it stood when it died.
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    stack.driver.tick(80);
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('u-1280.jpg');
        }).length, preferredCount,
        'the dead preferred URL is never retried');
}

// Every upgrade rung dead leaves the baseline standing — no fetch
// storm, no repaint of nothing.
async function allUpgradeRungsDeadLeavesTheBaseline() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [
            {src: 'u-960.jpg', width: 960, height: 540},
            {src: 'u-1280.jpg', width: 1280, height: 720}
        ],
        hostRect: {top: 0, bottom: 450, left: 0, right: 1200, width: 1200, height: 450}
    });
    stack.driver.tick(16);
    // Every rung dies in turn — the ladder keeps walking down until
    // nothing is left, then nothing more is requested at all.
    stack.images.forEach(function (image) {
        if (image.src.indexOf('u-') >= 0) {
            image.fail();
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    stack.images.forEach(function (image) {
        if (image.src.indexOf('u-') >= 0) {
            image.fail();
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline keeps standing');
    const deadCount = stack.images.length;
    stack.driver.tick(80);
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length, deadCount,
        'every rung dead — evaluation goes idle rather than retrying');
}

// During playback the intro's lead is the eased time horizon, never
// the scroll's eight-frame count: at elapsed ~1000 ms of the
// three-second run the horizon reaches index 60 — a lead eight frames
// deep would starve the dense middle of the catalog.
async function playingIntroLeadFollowsTimeNotAFrameCount() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack} = declaredPage({
        host: host,
        baseline: null,
        intro: {from: 0, to: 119, durationMs: 3000, easing: 'ease-in-out'},
        catalogDocument: {frames: Array.from({length: 120}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 200, height: 200, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(200, 200); });
    await settlePromises();
    stack.driver.tick(48); // the clock starts
    // Elapsed ~1000 ms — the eased horizon at +500 ms samples index
    // ~60: the demanded lead reaches far past eight frames. The slot
    // bound admits it in waves — each settle frees room for the next
    // stretch of the same horizon.
    stack.driver.tick(1048);
    for (let round = 0; round < 8; round += 1) {
        stack.images.forEach(function (image) {
            if (!image.settled) {
                image.settled = true;
                image.succeed(200, 200);
            }
        });
        await settlePromises();
        stack.driver.tick(1048 + (round + 1) * 16);
    }
    const fetched = stack.images.map(function (image) {
        const match = /f(\d+)\.jpg/.exec(image.src);
        return match ? Number(match[1]) : -1;
    });
    const deepest = Math.max.apply(null, fetched);
    assert.ok(deepest > 26 + 8,
        'the eased horizon demanded index ' + deepest +
            ' — far past any eight-frame cap');
}

// The scrub gate belongs to scroll-driven changes — a playing intro's
// demand is its eased forward horizon, not the scroll range's stored
// direction. The hero's own shape proves it: intro plays 0 to 119 while
// the scroll range runs 119 down to 24, so a gate computed on the
// scroll direction would demand frames behind the playhead. A miss at
// the dense middle must admit the forward lead only.
async function playingIntroNeverDemandsTheScrollGateSet() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.complete = false;
    host.naturalWidth = 0;
    const {stack} = declaredPage({
        host: host,
        baseline: null,
        sequenceFrom: 119,
        sequenceTo: 24,
        scrubBuffer: 3,
        intro: {from: 0, to: 119, durationMs: 3000, easing: 'ease-in-out'},
        catalogDocument: {frames: Array.from({length: 120}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 200, height: 200, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // Buffer zero — the opening frame alone releases the clock.
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg')) {
            image.succeed(200, 200);
        }
    });
    await settlePromises();
    stack.driver.tick(48); // the clock starts
    assert.strictEqual(presented(host), url('f0.jpg'), 'the opening frame painted');
    // One jump to elapsed ~1000 ms: the eased desire lands near 26 —
    // everything fetched after the initial cohort must be at or ahead of
    // the playhead, since the intro skips forward rather than replaying
    // a backlog. A request for a skipped frame (7 through 25) can only
    // come from a scrub-gate set on the scroll direction leaking into
    // playback: on the hero's range the stale direction is -1, so the
    // gate would demand {desired, desired - 1, desired - 2}.
    stack.driver.tick(1048);
    stack.images.forEach(function (image) {
        if (!image.settled) {
            image.succeed(200, 200);
        }
    });
    await settlePromises();
    stack.driver.tick(1064);
    const fetched = stack.images.map(function (image) {
        const match = /f(\d+)\.jpg/.exec(image.src);
        return match ? Number(match[1]) : -1;
    });
    const skipped = fetched.filter(function (index) {
        return index >= 7 && index <= 25;
    });
    assert.deepStrictEqual(skipped, [],
        'frames behind the playhead were demanded as if the scroll gate ' +
            'applied during the intro: ' + skipped.join(', '));
    assert.ok(Math.max.apply(null, fetched) > 27,
        'the eased forward lead is still the demand');
}

// Demand pays the budget like everything else: two retained
// 2048×2048 frames already account for the whole 32 MiB, so the next
// desired frame admits only by reclaiming the expendable member —
// the standing image and the demanded index stay protected. The
// reclaim is observable: scroll back to the evicted member and it
// must fetch again, because nothing else could have vacated its
// pixels before the new request started.
async function demandedFrameReclaimsExpendableRetained() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 2048, height: 2048, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // The baseline proof and one neighbor are all the budget admits —
    // 2 × 16 MiB is the whole account. The second wave admits after
    // the proof's settle frees the budget it was holding.
    await settleAll(stack.images, 2048, 2048);
    stack.driver.tick(32);
    await settleAll(stack.images, 2048, 2048); // the neighbor lands and retains
    stack.driver.tick(48);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('f0.jpg'), url('f1.jpg')].sort(),
        'the budget already caps speculation at two frames');
    scrollFraction(stack, scope, 1100); // progress .3 → desired 2
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the desired frame starts — reclaiming, not bypassing, the budget');
    // The evicted member proves the accounting ran before the request:
    // return to it while the demand is still in flight and it cannot
    // come back yet — the standing image plus the pending request is
    // already the whole account. The eviction is the evidence; the
    // refetch may only follow a settle that frees the room.
    scrollFraction(stack, scope, 950); // progress .15 → desired 1
    stack.driver.tick(80);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    }).length, 1,
        'the expendable member was released to fund the demand — its return waits for capacity');
    stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).forEach(function (image) { image.succeed(2048, 2048); });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    }).length, 2,
        'capacity freed by the settle admits the still-wanted frame');
}

// The single-frame exception is exactly that: an individually
// oversized mandatory frame — larger than the whole decoded budget —
// still admits when nothing gated it, and paints on arrival. The
// exception buys the one demanded frame, nothing more: no speculation
// rides along.
async function oversizedMandatoryFrameAdmitsAlone() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            // 4096×2112 ≈ 34.6 MB decoded — over the budget on its own.
            return {src: 'f' + index + '.jpg', width: 4096, height: 2112, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg')],
        'the oversized baseline proof admits — no speculation follows');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2
    stack.driver.tick(32);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg')],
        'the allowance is one outstanding replacement — the desire coalesces and waits');
    // The standing rep's proof settling frees the allowance: the
    // latest useful desire is what it then admits, alone.
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg')) {
            image.succeed(4096, 2112);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('f0.jpg'), url('f2.jpg')].sort(),
        'the oversized desire admits alone after the settle — the window cannot ride the exception');
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.succeed(4096, 2112);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the individually oversized frame still paints');
}

// The opening paint is the ready representation, not the index: a
// buffered intro over an authored 480 poster must come up at the
// selected 1280 the moment the buffer proves itself — no second
// fetch, no wait on the document's own load.
async function introPaintsTheSelectedRungOnStart() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        baseline: 'b0.jpg',
        document: {readyState: 'interactive'},
        resolution: true,
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        intro: {from: 0, to: 6, durationMs: 3000, easing: 'linear',
            bufferMs: 3000, skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            return {src: 'b' + index + '.jpg', width: 480, height: 270,
                upgrades: [{src: 'u' + index + '.jpg', width: 1280, height: 720}]};
        })}
    });
    stack.driver.tick(16);
    const requested = stack.images.map(function (image) { return image.src; });
    assert.ok(requested.length > 0 && requested.every(function (src) {
        return src.indexOf(url('u')) === 0;
    }), 'the required set requests the selected tier — never the base');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('b0.jpg');
    }), 'the selected-tier proof supplies readiness — no wasted base fetch');
    await settleAll(stack.images, 1280, 720);
    stack.driver.tick(32);
    await settleAll(stack.images, 1280, 720);
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the buffer lands and the clock starts — load still pending');
    assert.strictEqual(presented(host), url('u0.jpg'),
        'the first intro paint is the ready selected rung, not the poster');
    assert.strictEqual(host.getAttribute('src'), 'b0.jpg',
        'the host keeps its authored src: the sharper rung rides srcset');
}

// A closed scrub gate is not waived by standing on its own first
// member: initial entry with the authored frame already desired must
// fund the whole authored set — desired plus its following frames —
// as demand, ahead of any speculation.
async function closedGateDemandsItsSetOnSameIndexEntry() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        scrubBuffer: 3,
        document: {readyState: 'interactive'},
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.slice(0, 3).map(function (image) { return image.src; }).sort(),
        [url('f0.jpg'), url('f1.jpg'), url('f2.jpg')].sort(),
        'the whole required set is demand from the first pass — same index or not');
    await settleAll(stack.images);
    stack.driver.tick(32);
    // The funded gate opens — and repainting the standing frame with
    // its own tier is dead work the paint boundary now refuses, so the
    // baseline stands literally as authored.
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the funded gate opens on the standing frame without a dead repaint');
}

// Leaving and re-entering the approaching band is a fresh presentation
// decision: the gate closes on exit and the set must fund again on
// return — as demand, while the document is still loading — even when
// the desired index never changed.
async function closedGateReEvaluatesOnBandReentry() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        document: {readyState: 'interactive'},
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 400, 800);
    stack.driver.tick(32);
    // The entry set funds and opens — the standing frame needs no
    // repaint of its own tier, so the baseline is still as authored.
    assert.strictEqual(presented(host), url('f0.jpg'), 'the entry set funded and opened');
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(48); // out of the band — the window releases, the gate closes
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg') || image.src === url('f2.jpg');
    }).length, 4,
        're-entry re-funds the gate set — released members fetch again as demand');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1,
        'the proven displayed frame still counts toward its own set');
}

// An invalid range closes the gate the same way leaving does:
// measuring again re-evaluates the authored set rather than trusting
// the paint that happens to stand — recovery commits through the gate.
async function closedGateReEvaluatesAfterInvalidRange() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        // top-top..bottom-top anchors: the range measures only while
        // the subject has height, so collapsing it goes degenerate
        // without leaving the band.
        scopeStart: 'top top',
        scopeEnd: 'bottom top',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // Fund the set short of the last member — the gate stays closed
    // and the authored paint is never touched by a commit.
    stack.images.forEach(function (image) {
        if (image.src !== url('f2.jpg')) {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the short set holds the gate closed');
    // The range stops measuring — intent withdraws and the gate closes.
    scope.rect = {top: 0, bottom: 0, width: 100, height: 0};
    stack.window.fireEvent('scroll');
    stack.driver.tick(48);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('scroll');
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'recovery holds the gate — the same-index shortcut is gone');
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the whole set funds — the standing frame keeps its own tier');
    // The open gate is what a frame change proves: a ready desire
    // commits directly instead of re-funding a new closed set.
    scrollFraction(stack, scope, 1630); // this range: progress .15 → desired 1
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the recovered gate opened — a ready desire paints without re-funding');
}

// The intro's handoff lands on a closed gate too: ending the phase is
// a fresh presentation decision, so a desired index that equals the
// last intro paint still funds the authored set — members the intro's
// own range never covered fetch as demand.
async function introHandoffStillEvaluatesTheClosedGate() {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        scrubBuffer: 3,
        document: {readyState: 'interactive'},
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(32); // the opening frame proves — the clock starts
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro runs');
    // The user's own position ends the phase at the standing index.
    scrollFraction(stack, scope, 50); // offset moved — progress still ~0
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'the intro ends');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the closed gate funds {0,1,2} on handoff — outside the intro range');
    [0, 1, 2].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'the handoff demanded gate member ' + index);
    });
}

// Feasibility is priced in owned representations, not frame indices:
// seven 1440×810 members ask for 32,659,200 bytes — apparently inside
// 33,554,432 — but the standing 800×450 poster of a required frame is
// a distinct owned image still painted, so the set can never coexist.
// The intro abandons at once instead of fetching a doomed buffer and
// waiting out the deadline.
async function standingImagePricesIntoBufferFeasibility() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    const {stack, scope, skip} = declaredPage({
        host: host,
        baseline: 'lo0.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) {
                    timer.live = false;
                }
            }
        },
        intro: {from: 0, to: 6, durationMs: 3000, easing: 'linear',
            bufferMs: 3000, skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: [
            // The authored poster is the coarse base tier; the buffer's
            // selected 1440-wide representation is a different owned
            // image of the same frame.
            {src: 'lo0.jpg', width: 800, height: 450,
                upgrades: [{src: 'f0.jpg', width: 1440, height: 810}]},
            {src: 'f1.jpg', width: 1440, height: 810, upgrades: []},
            {src: 'f2.jpg', width: 1440, height: 810, upgrades: []},
            {src: 'f3.jpg', width: 1440, height: 810, upgrades: []},
            {src: 'f4.jpg', width: 1440, height: 810, upgrades: []},
            {src: 'f5.jpg', width: 1440, height: 810, upgrades: []},
            {src: 'f6.jpg', width: 1440, height: 810, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the unaffordable set abandons the wait before its first fetch');
    assert.ok(timers.every(function (timer) { return !timer.live; }),
        'the doomed wait retires its deadline instead of staying armed ' +
            'for the full 15 seconds');
    // The intro is over — scroll ownership continues on its own and the
    // live desire admits when its work lands.
    scrollFraction(stack, scope, 1300); // progress .5 → desired 3
    stack.driver.tick(32);
    await settleAll(stack.images, 1440, 810);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'the live scroll position owns the abandoned intro outright');
}

// The same accounting must not double-count either: when the standing
// image IS a required member's representation, the shared source
// prices once — the same seven 1440×810 members fit exactly, and the
// intro waits and plays normally.
async function sharedSourceCountsOnceInBufferFeasibility() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        resolution: true,
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        intro: {from: 0, to: 6, durationMs: 3000, easing: 'linear',
            bufferMs: 3000, skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            // The authored poster is the required 1440 rep itself —
            // member 0's fetch and the standing image are one source.
            return {src: 'f' + index + '.jpg', width: 1440, height: 810, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const members = stack.images.filter(function (image) {
        return (/f\d\.jpg$/).test(image.src);
    });
    assert.ok(members.length > 0,
        'the shared source counts once — the buffer fits and demands');
    assert.strictEqual(members.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1,
        'the standing rep funds the member it already is — one fetch, not two');
    await settleAll(stack.images, 1440, 810);
    stack.driver.tick(32);
    await settleAll(stack.images, 1440, 810);
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the feasible set lands and the clock starts');
}

// Crossing into the band is a measurement, not an admission: the pass
// drives, the gate decides — and a set the budget can never hold
// admits nothing at all, on the first entry and on every return.
async function deniedGateAdmitsNothingOnBandEntry() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        scrubBuffer: 5,
        scopeRect: {top: 9000, bottom: 9200, width: 100, height: 200},
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            // 1600×1200 × 5 = 38.4 MB — the authored set cannot coexist.
            return {src: 'f' + index + '.jpg', width: 1600, height: 1200, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'a far scene fetches nothing');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0,
        'the infeasible gate denies — band entry starts no requests');
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.strictEqual(stack.images.length, 0,
        're-entry re-measures into the same denial — still nothing');
}

// A denied set re-measures to the same verdict on every pass:
// re-entry at the same desire starts nothing, but a genuinely
// different set — one without the dead member — funds and resumes.
async function deadGateMemberDeniesUntilTheSetChanges() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) {
            image.fail();
        } else {
            image.succeed(400, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    const baselineRequests = stack.images.length;
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the dead member denies the set — the standing image stands');
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, baselineRequests,
        'the denied set re-evaluates to the same verdict — nothing re-admits');
    scope.rect = {top: 9000, bottom: 9200, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    assert.strictEqual(stack.images.length, baselineRequests,
        're-entry on the same denied set still admits nothing');
    scrollFraction(stack, scope, 1200); // progress .4 → desired 4: {4,5,6}
    stack.driver.tick(96);
    [4, 5, 6].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' — the changed set funds and resumes');
    });
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).length, 1, 'the dead source stays remembered — never retried');
}

// A host with no measured surface is not an intro: no buffer fetch,
// no deadline, no skip. When the geometry observer reports real
// dimensions the owner re-evaluates — the authored buffer prepares
// and the clock starts at elapsed zero, exactly as if the page had
// just become measurable.
async function zeroSizeHostStaysIdleUntilMeasurable() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        hostRect: {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0},
        window: {
            setTimeout: function (fn, ms) {
                timers.push({fn: fn, ms: ms});
                return timers.length;
            },
            clearTimeout: function () {}
        },
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear',
            bufferMs: 500, skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a host with no surface starts no intro work');
    assert.strictEqual(timers.length, 0,
        'no deadline arms against an unmeasurable surface');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'no skip for an intro that never began');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.ok(stack.images.length > 0,
        'becoming measurable admits the authored buffer');
    assert.strictEqual(timers.length, 1, 'the deadline arms only now');
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the wait resolves into the intro once measurable');
    // The clock started at this pass — elapsed zero: it retires only
    // after the full authored duration runs from here.
    stack.driver.tick(3048);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the full authored run completes — nothing was consumed early');
    stack.driver.tick(10000);
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'and it never replays');
}

// Takeover while the surface is absent ends the wait for good:
// becoming measurable afterwards resumes scroll ownership — the
// intro does not resurrect.
async function zeroSizeHostIntroStaysWithdrawnAfterTakeover() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, scope, skip} = declaredPage({
        host: host,
        hostRect: {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0},
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 300); // the user scrolled — progress ~0 clamped
    stack.driver.tick(32); // the moved offset withdraws the wait
    host.rect = {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the withdrawn intro never replays once measurable');
}

// A pending authored decode holds every gate: the intro waits on its
// opening frame and the scrub gate waits on the same unproven member
// — the paint that stands is the authored one until fulfillment.
async function pendingAuthoredDecodeOpensNeitherGate() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        scrubBuffer: 3,
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the pending decode holds the intro closed');
    scrollFraction(stack, scope, 50); // takeover — scroll owns now
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the pending member holds the scrub gate closed — nothing repaints');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the closed gate still demands its provable members');
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'fulfillment reconciles through the pass — the gate opens on the standing frame');
}

// A rejected decode is a dead source, not a pending one: the intro is
// abandoned without ever revealing its skip, a gate containing the
// dead member denies, the URL is never retried — and a set that
// avoids the member still funds normally.
async function rejectedAuthoredDecodeKeepsBothGatesClosed() {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        scrubBuffer: 3,
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        catalogDocument: {frames: Array.from({length: 10}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    assert.ok(proof, 'the adopted baseline owes its decode proof');
    proof.decodeShouldFail = true;
    proof.succeed(400, 800);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the rejected proof abandons the intro without a clock');
    scrollFraction(stack, scope, 50); // same-index — the gate holds a dead member
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the dead member denies the gate — the authored frame stands');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 1, 'the dead source is remembered — never retried');
    scrollFraction(stack, scope, 960); // progress .16 → desired 1: {1,2,3}
    stack.driver.tick(64);
    [1, 2, 3].forEach(function (index) {
        assert.ok(stack.images.some(function (image) {
            return image.src === url('f' + index + '.jpg');
        }), 'f' + index + ' — a set without the dead member still funds');
    });
}

// Without decode() the documented fallback is the load evidence the
// authored element already carries: a complete img with pixels is the
// readiness the platform can offer, so adoption is proof — the intro
// starts with zero requests.
async function loadOnlyPlatformAdoptsAuthoredReadiness() {
    FakeSubscription.reset();
    const noDecodeRegistry = imageRegistry();
    const {stack, skip} = declaredPage({
        window: {
            Image: function () {
                const image = noDecodeRegistry.Image();
                delete image.decode;
                return image;
            }
        },
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'load evidence is proof on a platform without decode');
    assert.strictEqual(stack.images.length, 0,
        'the adopted baseline needed no request to be ready');
}

// Capacity held by owned work is the budget, whatever class asked for
// it: a proven 16 MiB standing image plus a 16 MiB pending request is
// already the whole account, and an ordinary desire — the candidate
// itself well inside the budget — has no exemption. Each new intent
// waits on the same accounting; when the owned work settles only the
// latest intent admits, never a replay of superseded ones.
async function ordinaryDemandWaitsForOwnedCapacity() {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 2048, height: 2048, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1100); // progress .3 → desired 2
    stack.driver.tick(32);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).length, 0,
        'the desired frame waits — standing plus pending work already holds the account');
    scrollFraction(stack, scope, 1350); // progress .55 → desired 4
    scrollFraction(stack, scope, 1625); // progress .825 → desired 6
    stack.driver.tick(48);
    // The standing frame's own proof is the same URL as the standing
    // image — one decoded image, priced once — so the account holds
    // the standing f0 plus the one speculative f1 that fit beside it.
    assert.deepStrictEqual(stack.images.map(function (image) { return image.src; }),
        [url('f0.jpg'), url('f1.jpg')],
        'no ordinary request starts while the account is full');
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f6.jpg');
    }), 'capacity freed by the settle admits the latest intent');
    assert.ok(!stack.images.some(function (image) {
        return [2, 3, 4, 5].some(function (index) {
            return image.src === url('f' + index + '.jpg');
        });
    }), 'superseded desires never started and never replay');
}

// A member's reservation protects the representation the requirement
// actually needs, not the index it happens to share. Warm five 800²
// frames, enlarge the host so the policy selects 1600², and require
// frames 1–3: the three selected representations plus the standing
// 800² image price at 33,280,000 bytes — inside the budget — but the
// member's obsolete cached tier is not its funding and releases for
// the replacement. The control runs in the same pass: the member
// whose landed rep already satisfies the requirement stays
// protected — it is never evicted and never refetched.
async function obsoleteRequiredRepReleasesForItsReplacement() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 3,
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('s'))), 800, 800);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('f'))), 1600, 1600);
    stack.driver.tick(32);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('s'))), 800, 800);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('f'))), 1600, 1600);
    stack.driver.tick(48);
    // The host enlarges: every warmed 800² rep is now obsolete for the
    // 1600² requirement the gate puts on members 1–3.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    scrollFraction(stack, scope, 950); // progress .15 → desired 1 → gate {1,2,3}
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f3.jpg');
    }), 'the required member\'s obsolete cache releases for its selected rep');
    await settleAll(stack.images.filter(image => image.src.startsWith(url('s'))), 800, 800);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('f'))), 1600, 1600);
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the funded gate opens — the latest desire paints without another input');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg') || image.src === url('f2.jpg');
    }).length, 2,
        'each already-funded qualifying rep stayed protected — fetched once, never refetched');
}

// Failure is judged against the ladder the current policy can reach:
// the 1600² upgrade survives in the catalog but the CSS cap removes it
// from selection, so the base's death leaves nothing eligible. The
// wait is over at once — the deadline retires, the buffer never funds
// a dead set, and the live scroll position owns the presentation with
// no further input.
async function capExcludedSurvivingRungEndsTheIntroWait() {
    FakeSubscription.reset();
    const timers = [];
    const host = new Element('img', 'host');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    const {stack, scope, skip} = declaredPage({
        host: host,
        baseline: 's0.jpg',
        resolution: true,
        skipId: 'skip',
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) {
                    timer.live = false;
                }
            }
        },
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    }).forEach(function (image) { image.fail(); });
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(timers.every(function (timer) { return !timer.live; }),
        'the exhausted eligible ladder retires the wait\'s deadline at once');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'no skip for an intro that never started');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the cap-excluded rung is never attempted and never marked failed');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2
    stack.driver.tick(48);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('s2.jpg'),
        'the live scroll position owns the abandoned wait outright');
}

// Resolution enhancement disabled narrows the ladder the same way:
// the catalog's upgrade tiers are not eligible work, so a dead base
// exhausts every source the frame has. Same handoff, same retired
// deadline — the surviving catalog rung is not a reason to wait.
async function disabledResolutionDeadBaseEndsTheIntroWait() {
    FakeSubscription.reset();
    const timers = [];
    const {stack, scope, skip} = declaredPage({
        baseline: 's0.jpg',
        skipId: 'skip',
        intro: {from: 0, to: 1, durationMs: 3000, easing: 'linear', skip: '#skip'},
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) {
                    timer.live = false;
                }
            }
        },
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    }).forEach(function (image) { image.fail(); });
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(timers.every(function (timer) { return !timer.live; }),
        'no eligible source remains — the wait ends instead of polling');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the wait never became an intro');
}

// A denied scrub set stays denied while its set and the policy that
// killed it stand — and a legitimate policy change earns a fresh
// verdict. The cap excludes the only surviving rung, the set is dead
// on arrival; raising the cap makes the unattempted 1600² tier
// eligible again, and the gate funds and opens on its own.
async function scrubGateRecoversAfterPolicyChange() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    const {stack, scope} = declaredPage({
        host: host,
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    }).forEach(function (image) { image.fail(); });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the dead set closes the gate on the standing image');
    host.computedStyle = {'--paste-resolution-max-width': '1600'};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the policy change makes the unattempted tier eligible — the set refunds');
    await settleAll(stack.images.filter(image => image.src.startsWith(url('s'))), 800, 800);
    await settleAll(stack.images.filter(image => image.src.startsWith(url('f'))), 1600, 1600);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the re-funded gate opens and commits the surviving rung');
    assert.strictEqual(host.getAttribute('sizes'), '800px',
        'the unsized host keeps the base frame\'s layout width');
}

// A document already hidden when the sequence binds carries no intro
// at all: the wait withdraws at the first read — no deadline, no
// buffer funding beyond ordinary scroll demand, no skip, no clock.
// Returning visible hands the live scroll position ownership; the
// intro never replays.
async function hiddenDocumentNeverArmsTheIntroWait() {
    FakeSubscription.reset();
    const timers = [];
    const {stack, scope, host, skip} = declaredPage({
        document: {hidden: true},
        skipId: 'skip',
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) {
                    timer.live = false;
                }
            }
        }
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(timers.length, 0,
        'a hidden bind never arms the startup deadline');
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a hidden bind never exposes the skip');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the withdrawn wait does not become an intro on return');
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the authored baseline stands through the withdraw');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2
    stack.driver.tick(4016);
    await settleAll(stack.images);
    stack.driver.tick(4032);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the live position owns after the hidden withdraw');
}

// The same withdrawal fires inside the scheduled pass: a document
// that hides between the opening preparation's settle and the startup
// pass never arms the clock — the intro that could not start cannot
// replay on return either.
async function hidingBetweenProofAndStartWithdraws() {
    FakeSubscription.reset();
    const timers = [];
    const {stack, host, skip} = declaredPage({
        skipId: 'skip',
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        window: {
            setTimeout: function (fn, ms) {
                const timer = {fn: fn, ms: ms, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) {
                    timer.live = false;
                }
            }
        }
    });
    stack.driver.tick(16);
    stack.document.hidden = true; // hides before the event or the pass
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the hidden pass withdraws before the clock starts');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'returning shows the scroll presentation — the intro stays consumed');
    assert.ok(timers.every(function (timer) { return !timer.live; }),
        'no deadline survived the withdraw');
}

// A warmed lower tier never paints once the pass selects sharper:
// enlarge the host so 1600² becomes the requirement, then advance to
// another frame. The stale cache does not paint — the standing image
// holds — and the desired frame's selected representation is
// requested, never a lower tier; once the optional work already in
// flight settles, the newest desire's tier admits and paints.
async function scrubAdvanceHoldsForTheSelectedTier() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 800); });
    await settlePromises();
    stack.driver.tick(32);
    // Warm the lower tier by demand alone — desired frames are
    // demanded work, so the held load delays none of it.
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(64);
    scrollFraction(stack, scope, 1300); // progress .5 → desired 3
    stack.driver.tick(80);
    stack.images.forEach(function (image) {
        if (image.src === url('s3.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('s3.jpg'), 'the lower tier paints while it is the selection');
    const requestsBefore = stack.images.length;
    // The host enlarges: every warmed 800² rep is below the selected
    // 1600² tier now — including the one standing.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(112);
    scrollFraction(stack, scope, 950); // progress .15 → desired 0
    stack.driver.tick(128);
    scrollFraction(stack, scope, 1250); // progress .45 → desired 2
    stack.driver.tick(144);
    assert.strictEqual(presented(host), url('s3.jpg'),
        'the stale tier never paints — the last adequate frame stands');
    assert.ok(stack.images.slice(requestsBefore).some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the newly desired pose requested its selected tier at once');
    // Optional work already in flight keeps its room until it lands.
    stack.images.forEach(function (image) {
        if (image.src !== url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(150);
    const grown = stack.images.slice(requestsBefore).map(function (image) { return image.src; });
    assert.ok(grown.indexOf(url('f2.jpg')) >= 0, 'the newest desire requested its selected tier');
    assert.ok(!grown.some(function (src) {
        return [0, 1, 2, 3, 4, 5].some(function (index) {
            return src === url('s' + index + '.jpg');
        });
    }), 'no lower-tier request is made for the requirement');
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(160);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the selected tier\'s own completion paints without another input');
}

// Ordinary improvement of a healthy standing frame is optional work
// that requests against the policy measured in the pass that admits
// it: after the host grows past the displayed tier the sharper
// representation starts at once — no load gate — and paints on its
// own settle.
async function ordinarySharpeningFollowsTheFreshPolicy() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(48);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('s1.jpg'), 'the desired frame stands at the old tier');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the 800² policy never selected the sharper tier');
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the grown host sharpened the standing frame at once');
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the sharper standing commits on its own settle');
}

// A closed buffer's required member is demand wherever it lands —
// including the displayed index itself: after the host grows and the
// gate closes over {0}, the member whose cached tier no longer
// satisfies is fetched at its selected tier. Nothing waits on the
// document's own load: the standing frame's sharpening starts at once.
async function requiredMemberSharpeningAdmits() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 800); });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(64);
    scrollFraction(stack, scope, 900); // progress .2 → desired 0
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('s0.jpg'), 'the display returns to frame 0 at the old tier');
    // The host grows: with the gate open on the displayed index its
    // own sharpening is optional work — and optional work never waits
    // on the document's load.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the standing pose sharpens with the document still loading');
    // A closed set is different: the member under the pointer is
    // demand, and so is the displayed index when the set contains it.
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(112);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the closed gate\'s member fetches its selected tier');
    scrollFraction(stack, scope, 900); // progress .2 → desired 0
    stack.driver.tick(128);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f0.jpg');
    }), 'the displayed index inside the closed set is demanded too');
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(144);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the member\'s selected rep paints when the gate funds');
}

// A new desired pose is demand wherever it lands: with the host already
// at the sharper selection, scrolling to a fresh index asks for that
// frame's selected representation — the pose the page owes is not the
// standing frame's optional refinement.
async function newPoseSharpeningAdmits() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(1600, 1600); });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the standing pose is sharp already');
    const requestsBefore = stack.images.length;
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(48);
    assert.ok(requestsBefore > 0 && stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the new pose requested its selected tier');
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f1.jpg'), 'the new pose paints on its own settle');
}

// The same paint boundary holds inside playback: a warmed lower tier
// does not stand in for the next frame once the host demands the
// sharper selection — the clock's desire waits on its own tier, and
// the request is demanded work, not a post-load upgrade.
async function introAdvanceHoldsForTheSelectedTier() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        intro: {from: 0, to: 5, durationMs: 3000, easing: 'linear', bufferMs: 1000},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The startup buffer {0,1,2} warms at the lower tier, all demanded.
    stack.images.forEach(function (image) { image.succeed(800, 800); });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the opening frame stands — the authored baseline carries it');
    // The host enlarges inside playback's early clock: the eased
    // desire still advances, but the warmed 800² cache may not paint.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48); // the intro clock epochs here
    stack.driver.tick(548); // elapsed ~500 → eased index 1
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the stale cached tier does not stand in during playback either');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the clock\'s own desire requests its selected tier while load pends');
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(564);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the selected rep paints when it lands — never the cached lower tier');
}

// The documented fallback is the control: an actually-failed selected
// source yields the surviving lower rung to the same paint boundary —
// the dead URL is remembered, never retried, and the surviving rep
// paints on its own settle.
async function failedSelectedRungPaintsTheSurvivingFallback() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 800); });
    await settlePromises();
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('s1.jpg');
    }), 'the failed selected rung steps down to the surviving rep');
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('s1.jpg'),
        'the surviving lower rep paints — the fallback is allowed');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    }).length, 1, 'the dead selected URL is never retried');
}

// A dead base URL cannot deaden pixels the sequence already proved:
// with a one-frame gate, frame 2's base fails, its sharper tier is
// prepared and painted at the larger host, the display moves to
// frame 1 — and shrinking back finds the retained 1600² rep still
// eligible, still sufficient, painting again with no refetch at all.
async function retainedSharperRepPaintsWhenTheLadderIsExhausted() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The lookahead already asked for frame 2's base: that is the
    // request that fails.
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) {
            image.fail();
        } else {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the failed base could not paint — the gate stayed shut on the authored baseline');
    // The host grows: the sharper rung is eligible again, prepares,
    // and displays.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the sharper rep paints at the grown host');
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(112);
    // Speculation already in flight holds its room until it settles;
    // once everything outstanding lands, frame 1's selected tier fits.
    for (let round = 0; round < 3; round += 1) {
        await settleAll(stack.images, 1600, 1600);
        stack.driver.tick(113 + round);
    }
    stack.driver.tick(128);
    assert.strictEqual(presented(host), url('f1.jpg'), 'the display moves on — frame 2 stays cached');
    const frameTwoRequests = function () {
        return stack.images.filter(function (image) {
            return image.src === url('s2.jpg') || image.src === url('f2.jpg');
        }).length;
    };
    const requestsBefore = frameTwoRequests();
    // The host shrinks: the selected rung is the dead base — nothing
    // remains to request — but the retained sharper rep is usable
    // evidence and paints without a single new request.
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(144);
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2 again
    stack.driver.tick(160);
    await settlePromises();
    stack.driver.tick(176);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the retained sharper rep paints — no request survives to make, none needed');
    assert.strictEqual(frameTwoRequests(), requestsBefore,
        'exhaustion is not death: owned evidence funds the paint');
}

// The same retained rep is NOT a reprieve when the cap excludes it:
// shrinking with the cap at 800 makes the sharper cache ineligible,
// so the exhausted ladder is genuinely dead — the gate stays closed
// and no request is made for what cannot paint.
async function capKeepsTheExhaustedGateClosed() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(800, 800); });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // desired 2
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(96);
    scrollFraction(stack, scope, 1100); // desired 1
    stack.driver.tick(112);
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(128);
    assert.strictEqual(presented(host), url('f1.jpg'));
    const requestsBefore = stack.images.length;
    // The cap now excludes the retained sharper rep: nothing usable
    // remains and nothing survives to fetch — the member is dead.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(144);
    scrollFraction(stack, scope, 1300); // desired 2 again
    stack.driver.tick(160);
    await settlePromises();
    stack.driver.tick(176);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the cap-ineligible cache cannot stand in — the dead member keeps the gate shut');
    assert.ok(!stack.images.slice(requestsBefore).some(function (image) {
        return image.src === url('s2.jpg') || image.src === url('f2.jpg');
    }), 'a genuinely dead member starts no request');
}

// The reservation reprices at the current selection: warmed 1600²
// members of a four-frame gate cannot veto the 800² set the policy
// now funds. The overqualified cache of the farthest member releases
// for its selected rep while the nearer member's sharper rep still
// fits — kept, painted, never refetched. The whole gate opens on
// accounting alone, with no further input.
async function overqualifiedCacheRepricesForTheFeasibleGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'f0.jpg',
        resolution: true,
        scrubBuffer: 4,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        // The intro's own buffer is the warmer — its {0,1,2} set at
        // the 1600² selection fits where the four-member scrub gate
        // at that tier could not.
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', bufferMs: 3000},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    const landed = new Set();
    const settle = async function () {
        stack.images.forEach(function (image) {
            if (!landed.has(image)) {
                landed.add(image);
                const size = image.src.startsWith(url('s')) ? 800 : 1600;
                image.succeed(size, size);
            }
        });
        await settlePromises();
    };
    stack.driver.tick(16);
    await settle();
    stack.driver.tick(32);
    await settle();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the standing frame is the sharper authored rep');
    // The host shrinks inside the opening clock: the lead's members
    // all stay usable, so nothing new is demanded — and the scroll
    // that follows hands a four-member scrub gate {1,2,3,4} priced at
    // the 800² selection.
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1 → gate {1,2,3,4}
    stack.driver.tick(80);
    await settle();
    stack.driver.tick(96);
    await settle();
    stack.driver.tick(112);
    await settle();
    stack.driver.tick(128);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('s3.jpg') || image.src === url('s4.jpg');
    }), 'the unfunded members fetch their selected rep — the gate funds');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('s2.jpg');
    }), 'the reclaimed overqualified member refetches at the selected tier');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('s1.jpg');
    }), 'the member whose sharper cache still fits is never refetched');
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the repriced gate opens and paints the retained sharper rep');
}

// The same reservation keeps sharper cache outright when the
// complete set fits keeping it: one overqualified member among
// four is affordable, so its rep funds the gate from the start —
// never evicted, never refetched — and the gate opens on it.
async function sharperCacheKeptWhenTheSetAffordsIt() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'f0.jpg',
        resolution: true,
        scrubBuffer: 4,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', bufferMs: 3000},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                // Only the opening members carry a sharper rung, so
                // the intro's buffer warms exactly member 1
                // overqualified for the smaller host to come.
                upgrades: index <= 1 ?
                    [{src: 'f' + index + '.jpg', width: 1600, height: 1600}] : []
            };
        })}
    });
    const landed = new Set();
    const settle = async function () {
        stack.images.forEach(function (image) {
            if (!landed.has(image)) {
                landed.add(image);
                image.succeed(image.src === url('s2.jpg') ||
                        image.src === url('s3.jpg') || image.src === url('s4.jpg') ?
                    800 : 1600, image.src === url('s2.jpg') ||
                    image.src === url('s3.jpg') || image.src === url('s4.jpg') ?
                    800 : 1600);
            }
        });
        await settlePromises();
    };
    stack.driver.tick(16);
    await settle();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the standing frame is the sharper authored rep');
    const requestsBefore = stack.images.length;
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    scrollFraction(stack, scope, 1100); // desired 1 → gate {1,2,3,4}
    stack.driver.tick(64);
    await settle();
    stack.driver.tick(80);
    await settle();
    stack.driver.tick(96);
    assert.ok(!stack.images.slice(requestsBefore).some(function (image) {
        return image.src === url('s1.jpg');
    }), 'the affordable sharper cache is never evicted and never refetched');
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the kept cache opens the gate and paints');
}

// A set that cannot fund its selected representations stays closed:
// four 2048² members beside the standing image price far above the
// budget at any keep — the denial is the authored threshold's answer,
// not an eviction storm, and nothing optional starts on its account.
async function infeasibleSelectedSetKeepsTheGateClosed() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'g0.jpg',
        scrubBuffer: 4,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {src: 'g' + index + '.jpg', width: 2048, height: 2048, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) { image.succeed(2048, 2048); });
    await settlePromises();
    stack.driver.tick(32);
    const requestsBefore = stack.images.length;
    scrollFraction(stack, scope, 1100); // desired 1 → gate {1,2,3,4}
    stack.driver.tick(48);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(stack.images.length, requestsBefore,
        'a genuinely infeasible selected set admits nothing');
    assert.strictEqual(presented(host), url('g0.jpg'),
        'the denied gate never opens — the standing image stands');
}

// The oversized exception is one bounded replacement, not an open
// account: a 33 MiB standing image plus one outstanding 33 MiB
// replacement already outspend the budget — desires that move while
// the replacement is still pending coalesce and wait, and only the
// latest useful desire admits after the settle.
async function oversizedReplacementCoalescesUntilSettle() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'g0.jpg',
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            return {src: 'g' + index + '.jpg', width: 4096, height: 2112, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) {
        if (image.src === url('g0.jpg')) { image.succeed(4096, 2112); }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1100); // progress .3 → desired 2
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('g2.jpg');
    }).length, 1, 'one oversized mandatory replacement admits');
    scrollFraction(stack, scope, 1300); // progress .5 → desired 3
    scrollFraction(stack, scope, 1500); // progress .7 → desired 4
    scrollFraction(stack, scope, 1700); // progress .9 → desired 6
    stack.driver.tick(64);
    assert.strictEqual(stack.images.length, 2,
        'the outstanding replacement caps the allowance — newer desires coalesce and wait');
    assert.strictEqual(presented(host), url('g0.jpg'),
        'the standing image stands while its replacement is unsettled');
    // The pending op settles — decode and all — and the latest useful
    // desire is what the freed allowance takes, never the skipped
    // intermediate sequence.
    stack.images.forEach(function (image) {
        if (image.src === url('g2.jpg')) { image.succeed(4096, 2112); }
    });
    await settlePromises();
    stack.driver.tick(80);
    await settlePromises();
    stack.driver.tick(96);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('g6.jpg');
    }), 'the latest desire admits once the replacement settles');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('g3.jpg') || image.src === url('g4.jpg') ||
            image.src === url('g5.jpg');
    }), 'the superseded desires never became requests');
    stack.images.forEach(function (image) {
        if (image.src === url('g6.jpg')) { image.succeed(4096, 2112); }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('g6.jpg'), 'the settled latest paints');
}

// An optional candidate is admitted only inside what the required
// set leaves free — including the members it has not yet requested.
// The closed gate {1,2} needs two 1900² representations beside the
// standing 800² image: older outstanding requests already block the
// second member, and the standing frame's own optional sharpening
// would consume exactly the capacity the buffer is waiting on. The
// candidate is refused, the older requests settle, and the required
// buffer funds on its own — no further input.
async function optionalWorkReservesTheUnfundedGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        // Unrendered until the detour: no speculation runs before the
        // older requests the scenario needs are outstanding.
        hostRect: {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0},
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 1600, height: 1600}]
                };
            }
            if (index === 1 || index === 2) {
                return {src: 'b' + index + '.jpg', width: 1900, height: 1900, upgrades: []};
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'an unrendered host requested work');
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    // Two older outstanding requests that block the second member.
    scrollFraction(stack, scope, 1450); // progress .65 → desired 4 → gate {4,5}
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('s4.jpg');
    }) && stack.images.some(function (image) {
        return image.src === url('s5.jpg');
    }), 'the detour gate leaves its members outstanding');
    scrollFraction(stack, scope, 1200); // progress .4 → desired 2 → gate {2,1}
    stack.driver.tick(64);
    const requested = function (name) {
        return stack.images.some(function (image) { return image.src === url(name); });
    };
    assert.ok(requested('b1.jpg') !== requested('b2.jpg'),
        'one member waits — the outstanding work already fills the room');
    const waiting = requested('b2.jpg') ? 'b1.jpg' : 'b2.jpg';
    // The host grows so frame 0 selects its sharper rung — optional
    // improvement of a healthy standing frame. The closed set {1,2}
    // still owes 14.44 MiB for its missing member; the upgrade must
    // not be admitted on that account.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    await settlePromises();
    stack.driver.tick(96);
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('u0.jpg');
    }), 'optional sharpening never displaces the required buffer\'s funding');
    // The older requests — the detour's members, its lookahead and the
    // baseline's proof — settle; the set funds its last member
    // without another input.
    stack.images.forEach(function (image) {
        if (image.src !== url('u0.jpg')) {
            image.succeed(/\/b[12]\.jpg$/.test(image.src) ? 1900 : 800,
                /\/b[12]\.jpg$/.test(image.src) ? 1900 : 800);
        }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.ok(requested(waiting), 'the waiting member admits once the older work settles');
    stack.images.forEach(function (image) {
        if (image.src === url(waiting)) { image.succeed(1900, 1900); }
    });
    await settlePromises();
    stack.driver.tick(128);
    assert.strictEqual(presented(host), url('b2.jpg'),
        'the gate opens and the desired member paints');
}

// The other half of the reservation: an optional upgrade admitted
// before the gate existed stays physically accounted while in flight,
// but its arrival must not displace the current buffer — the parked
// rep cannot paint the standing image larger while the set cannot
// fund the enlarged standing, and the parked bytes stay reclaimable.
async function landedUpgradeNeverDisplacesTheClosedGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 1600, height: 1600}]
                };
            }
            if (index === 1 || index === 2) {
                return {src: 'b' + index + '.jpg', width: 1900, height: 1900, upgrades: []};
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // The opening gate {0,1} demands the selected tier for its own
    // member — held unsettled so the scroll moves the requirement
    // before it lands.
    assert.ok(stack.images.some(function (image) {
        return image.src === url('u0.jpg');
    }), 'the opening member requests its selected rep');
    scrollFraction(stack, scope, 1000); // progress .2 → desired 1 → gate {1,2}
    stack.driver.tick(32);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b1.jpg');
    }), 'the new set\'s first member is in flight');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('b2.jpg');
    }), 'the second member waits — the outstanding work already fills the room');
    // The earlier member request lands inside the closed gate: its
    // pixels park as unfunded cache, never the standing image.
    // The speculative lookahead admitted beside the opening gate lands
    // with it.
    stack.images.forEach(function (image) {
        if (image.src === url('u0.jpg')) {
            image.succeed(1600, 1600);
        } else if (/\/s[3-6]\.jpg$/.test(image.src)) {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the landed rep cannot enlarge the standing image past the set\'s funding');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b2.jpg');
    }), 'its parked bytes release for the member that needed them');
    stack.images.forEach(function (image) {
        if (image.src === url('b1.jpg') || image.src === url('b2.jpg')) {
            image.succeed(1900, 1900);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('b1.jpg'),
        'the required buffer recovers on settlement alone');
}

// The control beside both: where the required set already fits, the
// optional sharpening of the standing frame admits and paints inside
// the surplus while the set still waits — the reservation is a share,
// not a ban.
async function surplusCapacityPermitsOptionalSharpening() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: index === 0 ?
                    [{src: 'u0.jpg', width: 1600, height: 1600}] : []
            };
        })}
    });
    stack.driver.tick(16);
    // The gate {0, 1} waits on frame 1, which stays in flight.
    stack.images.forEach(function (image) {
        if (image.src !== url('s1.jpg')) {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the baseline stands proven — its own tier needs no repaint');
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('u0.jpg');
    }), 'surplus capacity admits the optional sharpen');
    stack.images.forEach(function (image) {
        if (image.src === url('u0.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u0.jpg'),
        'the standing frame sharpens inside what the set leaves free');
}

// Sharpening serves the standing frame only while it is still the
// desired one: with the desire moved to a closed gate's set, a sharper
// rung of the frame about to be replaced is never fetched; once the
// desire returns to the standing frame, the same sharpen admits.
async function movedDesireNeverSharpensTheStandingFrame() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: index === 0 ?
                    [{src: 'u0.jpg', width: 1600, height: 1600}] : []
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.forEach(function (image) {
        if (image.src !== url('s3.jpg') && image.src !== url('s4.jpg')) {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // progress .5 → desired 3 → gate {3,4}
    stack.driver.tick(48);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('s0.jpg'), 'the closed gate holds the standing frame');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('u0.jpg');
    }), 'the standing frame sharpened while the desire stood elsewhere');
    scrollFraction(stack, scope, 0);
    stack.driver.tick(96);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('u0.jpg');
    }), 'the desire returned and the standing frame never sharpened');
}

// A useful pending representation is not readiness, but it is not
// exhaustion either: frame 2's base fails at the small host, its
// sharper rep starts at the larger host, the host shrinks back
// before it lands — the gate waits for the owned arrival instead of
// recording a dead verdict that outlives it, and the landed rep
// paints without another input.
async function pendingSharperRepReopensTheDeniedGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The lookahead already asked for frame 2's base: that request fails.
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) {
            image.fail();
        } else {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // progress .5 → desired 2
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the failed base keeps the gate closed — the ladder is exhausted here');
    // The larger host selects and starts the sharper rep.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the surviving rung is demanded at the larger host');
    // It is still in flight when the host returns to the failed
    // selection — an owned arrival, not an exhaustion.
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'not ready yet — the gate waits on the owned operation');
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(128);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the landed sharper rep re-opens the gate and paints on its own settle');
}

// A pending rep the cap already excludes is not a reprieve: shrink
// with the cap at 800 and the in-flight 1600² work no longer counts
// as useful evidence — the member is genuinely exhausted, the gate
// stays denied, and its arrival parks nothing.
async function capIneligiblePendingRepIsExhaustion() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The lookahead already asked for frame 2's base: that request fails.
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) {
            image.fail();
        } else {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // desired 2
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f2.jpg');
    }), 'the surviving rung is in flight');
    const requestsBefore = stack.images.length;
    // The cap now excludes what the pending op is bringing: there is
    // nothing left worth waiting for.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the cap-ineligible arrival changes nothing — the member stays dead');
    assert.strictEqual(stack.images.length, requestsBefore,
        'no further request is made for a genuinely exhausted member');
}

// A pending rep that fails is exhaustion too: the settle removes the
// last hope instead of satisfying it — the verdict turns dead and
// the gate stays shut, exactly as a ladder with no pending work.
async function failedPendingRepIsExhaustion() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 1,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The lookahead already asked for frame 2's base: that request fails.
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) {
            image.fail();
        } else {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // desired 2
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(64);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    const requestsBefore = stack.images.length;
    // The pending rep fails too — now the ladder is honestly dead.
    stack.images.forEach(function (image) {
        if (image.src === url('f2.jpg')) { image.fail(); }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the failed pending rep resolves to exhaustion — the gate stays closed');
    assert.strictEqual(stack.images.length, requestsBefore,
        'nothing remains worth requesting');
}

// The same reprieve holds inside the startup wait: a member whose
// own ladder has died but whose already-owned operation can still
// deliver a qualifying rep does not abandon the intro — the wait
// holds, the original deadline is neither reset nor consumed, and
// the intro starts when the arrival lands.
async function introWaitHoldsForAQualifyingPendingRep() {
    FakeSubscription.reset();
    const timers = [];
    const {stack, scope, host, skip} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        skipId: 'skip',
        window: {
            setTimeout: function (fn, ms) {
                timers.push({fn: fn, ms: ms});
                return timers.length;
            },
            clearTimeout: function () {}
        },
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear',
            bufferMs: 1000, skip: '#skip'},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'f' + index + '.jpg', width: 1600, height: 1600}]
            };
        })}
    });
    stack.driver.tick(16);
    // The {0,1} startup buffer demands its members at the 800²
    // selection; one proves, the other's own source dies.
    stack.images.forEach(function (image) {
        if (image.src === url('s0.jpg')) { image.succeed(800, 800); }
        if (image.src === url('s1.jpg')) { image.fail(); }
    });
    await settlePromises();
    // Before the failure's pass can run the host grows — the member's
    // ladder survives at the larger selection and the demand starts
    // there, still in flight when the host returns to the dead one.
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the member\'s surviving rung starts at the larger selection');
    host.rect = {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the wait holds for the owned arrival — it does not abandon');
    assert.strictEqual(timers.length, 1,
        'the original deadline stays armed once — never reset');
    assert.strictEqual(timers[0].ms, 15000, 'the authored wait bound is unchanged');
    stack.images.forEach(function (image) {
        if (image.src === url('f0.jpg') || image.src === url('f1.jpg')) {
            image.succeed(1600, 1600);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the qualifying arrival starts the intro');
}

// The reservation prices standing ownership once: frame 0 stands at
// the sharper selection after the intro's handoff, frame 1's
// same-tier cache is retained, and the smaller selection funds the
// valid mixture — the standing rep reused for its own member, the
// other members at the selected tier. Neither extreme answers:
// keeping every qualifying cache is too much, and charging a
// redundant selected rep beside the standing is too much. The
// overqualified member's cache releases, the members prepare at the
// selected tier, and the gate opens without further input.
async function standingReuseFundsTheFeasibleMixture() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'b0.jpg',
        resolution: true,
        scrubBuffer: 3,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 2048, left: 0, right: 2048, width: 2048, height: 2048},
        // The intro hands off with the gate closed over the scroll
        // position's own set — its backward run warms {0,1} at the
        // sharper selection and leaves frame 0 standing.
        intro: {from: 1, to: 0, durationMs: 2000, easing: 'linear', bufferMs: 2000},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 1400, height: 1400,
                upgrades: [{src: 'b' + index + '.jpg', width: 2048, height: 2048}]
            };
        })}
    });
    const settle = async function () {
        stack.images.forEach(function (image) {
            if (image.src.indexOf(url('b')) === 0) {
                image.succeed(2048, 2048);
            } else {
                image.succeed(1400, 1400);
            }
        });
        await settlePromises();
    };
    stack.driver.tick(16);
    await settle();
    stack.driver.tick(32);
    await settle();
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b0.jpg');
    }) && stack.images.some(function (image) {
        return image.src === url('b1.jpg');
    }), 'the startup buffer warms at the sharper selection');
    stack.driver.tick(1048); // mid-play — the clock paints index 0
    await settle();
    stack.driver.tick(2100); // the intro plays out and hands off
    assert.strictEqual(presented(host), url('b0.jpg'),
        'the handoff leaves frame 0 standing at the sharper rep');
    const requestsBefore = stack.images.length;
    // The host shrinks to the 1400² selection: the handoff gate
    // {0,1,2} is feasible only as the mixture — standing reuse plus
    // the members' own selected reps (32,457,216 bytes of 33,554,432).
    host.rect = {top: 0, bottom: 1400, left: 0, right: 1400, width: 1400, height: 1400};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(2116);
    await settle();
    stack.driver.tick(2132);
    await settle();
    stack.driver.tick(2148);
    const grown = stack.images.slice(requestsBefore).map(function (image) {
        return image.src;
    });
    assert.ok(!grown.some(function (src) {
        return src === url('s0.jpg') || src === url('b0.jpg');
    }), 'the standing rep funds its member — no redundant selected request');
    assert.ok(grown.indexOf(url('s1.jpg')) >= 0 && grown.indexOf(url('s2.jpg')) >= 0,
        'the other members prepare at the selected tier');
    assert.strictEqual(presented(host), url('b0.jpg'),
        'the gate opens without another input — the standing rep stands');
}

// 'Already prepared' and 'allowed to paint now' are separate questions:
// the standing frame's sharper rep lands while the closed gate cannot
// fund the enlarged standing, so its paint defers — but the parked rep
// still answers the selection, and every later evaluation must see the
// same answer. A denied gate that keeps re-preparing the deferred rep
// is the loop this case hangs on: repeated passes mint a new request
// for the same source while nothing ever paints.
async function deferredUpgradeNeverLoopsPreparation() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 3,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 1600, height: 1600}]
                };
            }
            if (index <= 2) {
                // 1900² members: the set {0,1,2} funds 10.24 MiB at the
                // member's selected rep beside 28.88 — intrinsically
                // infeasible, so the standing upgrade's paint defers
                // for as long as evaluation runs.
                return {src: 'b' + index + '.jpg', width: 1900, height: 1900, upgrades: []};
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // The opening member's own selected rep is the u0 fetch — the set
    // cannot fund it, but admission never refused the request itself.
    const u0s = function () {
        return stack.images.filter(function (image) {
            return image.src === url('u0.jpg');
        }).length;
    };
    stack.images.forEach(function (image) {
        if (image.src === url('u0.jpg')) { image.succeed(1600, 1600); }
    });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(u0s(), 1, 'the deferred rep landed and parked');
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the paint deferred — the set cannot fund the enlarged standing');
    // Repeated owner passes — each one re-evaluates the deferred rep —
    // must keep suppressing the same request. A completion-driven retry
    // loop would mint u0 loads forever while nothing paints.
    stack.driver.tick(48);
    stack.driver.tick(64);
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    await settleAll(stack.images);
    stack.driver.tick(96);
    assert.strictEqual(u0s(), 1, 'one preparation per retained source — no retry loop');
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the standing image stands through every deferred evaluation');
    assert.strictEqual(stack.driver.pending(), 0, 'the owner went idle');
}

// The feasible sibling: the closed set {1,2} can fund — it only waits
// because older outstanding work occupies the room. The standing
// frame's admitted upgrade lands into the wait, parks as reclaimable
// unfunded cache, and its bytes release for the member that needs
// them — one preparation per retained source, and the buffer recovers
// on settlement alone.
async function blockedUpgradePreparesOnceWhileTheSetWaits() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        document: {readyState: 'interactive'},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 7}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 1600, height: 1600}]
                };
            }
            if (index === 1 || index === 2) {
                return {src: 'b' + index + '.jpg', width: 1900, height: 1900, upgrades: []};
            }
            if (index === 3) {
                return {src: 'g3.jpg', width: 2700, height: 2700, upgrades: []};
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const u0s = function () {
        return stack.images.filter(function (image) {
            return image.src === url('u0.jpg');
        }).length;
    };
    assert.strictEqual(u0s(), 1, 'the opening member requests its selected rep');
    // Into the denied set {3,4} before the member's request lands —
    // the denied gate evaluates sharpening every pass while the parked
    // rep answers the selection already.
    scrollFraction(stack, scope, 1250); // desired 3 → gate {3,4} denied
    stack.driver.tick(32);
    // The member's request lands — and so does the speculation that
    // was admitted beside it; only the set's own members stay out.
    stack.images.forEach(function (image) {
        if (image.src !== url('b1.jpg') && image.src !== url('b2.jpg')) {
            image.succeed(image.src === url('u0.jpg') ? 1600 : 800,
                image.src === url('u0.jpg') ? 1600 : 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the landed rep cannot enlarge the standing image past the denied set');
    stack.driver.tick(64);
    stack.driver.tick(80);
    assert.strictEqual(u0s(), 1,
        'the deferred rep suppresses re-preparation while the denied gate waits');
    // Back on the feasible set {2,1}, the parked bytes release for
    // the member that needed them.
    scrollFraction(stack, scope, 1100); // desired 2 → gate {2,1}
    stack.driver.tick(96);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b2.jpg');
    }), 'its parked bytes release for the member that needed them');
    stack.images.forEach(function (image) {
        if (image.src === url('b1.jpg') || image.src === url('b2.jpg')) {
            image.succeed(1900, 1900);
        }
    });
    await settlePromises();
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('b2.jpg'),
        'the feasible buffer recovers once the older work settles');
    assert.strictEqual(u0s(), 1, 'the reclaimed rep was never re-requested');
}

// A landed repair changes what the required set must fund — the failed
// 1600² standing image yields to its healthy 800² fallback, and the
// 39.12 MiB estimate falls to 31.44 — inside the budget. The verdict
// belongs to the pass that saw the change, and the standing change
// itself owes the owner one more pass: the newly fundable members
// admit and open without another scroll, resize, or settle.
async function smallerRepairReopensTheRequiredGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'u0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 'b0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 1600, height: 1600}]
                };
            }
            if (index === 1 || index === 2) {
                return {src: 'b' + index + '.jpg', width: 1900, height: 1900, upgrades: []};
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    // The adopted 1600² upgrade owes its proof — and it fails: the
    // standing image is now a dead source.
    const u0 = stack.images.filter(function (image) {
        return image.src === url('u0.jpg');
    })[0];
    assert.ok(u0, 'the displayed upgrade rep owes its decode proof');
    // The set {0,1} funds: the displayed 1600² and its own proof are
    // one URL — one decoded image, priced once — so the second member
    // admits beside it.
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b1.jpg');
    }), 'the standing image and its proof were priced twice');
    // The small speculative frames that fit beside them land — owned
    // retained work a demanded member may reclaim, not physical
    // requests holding the account.
    stack.images.forEach(function (image) {
        if ((/\/s[0-9]\.jpg$/).test(image.src)) { image.succeed(800, 800); }
    });
    await settlePromises();
    scrollFraction(stack, scope, 1000); // desired 1 → gate {1,2}
    stack.driver.tick(32);
    u0.fail();
    await settlePromises();
    stack.driver.tick(48);
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('b2.jpg');
    }), 'the 39.12 MiB estimate denies the set — the second member never starts');
    // The standing frame's own repair is evaluated even inside the
    // denial — the failed source's fallback admits.
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b0.jpg');
    }), 'the failed standing image\'s fallback is the repair');
    stack.images.forEach(function (image) {
        if (image.src === url('b0.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('b0.jpg'),
        'the healthy fallback replaces the dead standing image');
    // The repair repriced the set: 31.44 MiB funds — the members admit
    // on the wake of the paint alone.
    stack.driver.tick(80);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('b2.jpg');
    }), 'the repriced set admits its member without another input');
    stack.images.forEach(function (image) {
        if (image.src === url('b1.jpg') || image.src === url('b2.jpg')) {
            image.succeed(1900, 1900);
        }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('b1.jpg'),
        'the reopened gate commits the desired member');
}

// A reprioritized request keeps its slot until it settles — and its
// result is weighed against the live desire when it lands. Reversing
// direction while frame 1 is physically in flight does not deaden its
// completion: the landed rep is exactly the wanted one, it paints from
// that first preparation, and no second request ever starts.
async function reversalPaintsTheFirstCompletedPreparation() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 800, height: 450, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const f0 = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    f0.succeed(800, 450); // the proof lands — frame 0 stands
    await settlePromises();
    stack.driver.tick(32); // the freed slot admits f6 — frames 1..6 in flight
    assert.strictEqual(stack.images.length, 7,
        'the six physical slots hold the live window');
    scrollFraction(stack, scope, 1700); // progress .9 → desired 7
    stack.driver.tick(48);
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f7.jpg');
    }), 'the demanded frame waits — a reprioritized slot releases at settle, not now');
    // Reverse to 1 before its operation settles — the same physical
    // request the detour deprioritized is exactly the wanted work.
    scrollFraction(stack, scope, 940); // progress .14 → desired 1
    stack.driver.tick(64);
    const f1s = function () {
        return stack.images.filter(function (image) {
            return image.src === url('f1.jpg');
        }).length;
    };
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(800, 450); }
    });
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'the first completed preparation paints the reversed desire');
    assert.strictEqual(f1s(), 1,
        'the landed op was weighed, not discarded — no second preparation');
    stack.driver.tick(96);
    assert.strictEqual(f1s(), 1, 'and nothing starts it again');
}

// Reconsideration is not resurrection: the reversed-to rep that lands
// cap-ineligible parks nothing paintable — the frame still owes the
// policy-selected rep, and only that rep may commit.
async function parkedCompletionNeverPaintsOverCap() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'u0.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {
                src: 's' + index + '.jpg', width: 800, height: 450,
                upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 900}]
            };
        })}
    });
    stack.driver.tick(16);
    const u0 = stack.images.filter(function (image) {
        return image.src === url('u0.jpg');
    })[0];
    assert.ok(u0, 'the displayed rep proves at its own rung');
    u0.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1700); // desired 7 — the detour begins
    stack.driver.tick(48);
    scrollFraction(stack, scope, 940); // reverse to 1 while u1 flies
    // The cap closes over what the pending op is bringing: its arrival
    // is no longer paintable work, so the member still owes the
    // policy's own selection.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    stack.images.forEach(function (image) {
        if (image.src === url('u1.jpg')) { image.succeed(1600, 900); }
    });
    await settlePromises();
    stack.driver.tick(80);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('s1.jpg');
    }), 'the cap-compliant rep is what the member now prepares');
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 450); }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('s1.jpg'),
        'the policy-selected rep paints — the over-cap arrival never stands');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1.jpg');
    }).length, 1, 'the ineligible rep was never re-requested either');
}

// The same boundary under reduced motion: a completion that lands
// after the preference withdraws animation is dead work — the parked
// result never resurfaces as presentation when motion returns.
async function parkedCompletionStaysDeadUnderReducedMotion() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return motion; }},
        catalogDocument: {frames: Array.from({length: 8}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 800, height: 450, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const f0 = stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0];
    f0.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1700); // desired 7 — intent on the far end
    motion.set(true); // animation withdraws mid-flight — the baseline restores
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg')) { image.succeed(800, 450); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the withdrawn-intent completion never paints over the baseline');
    // Motion returns: the desire recomputes from the live position —
    // the dropped completion cannot reappear as owned evidence for the
    // frame it once served.
    motion.set(false);
    scrollFraction(stack, scope, 940); // desired 1
    stack.driver.tick(80);
    const f1s = stack.images.filter(function (image) {
        return image.src === url('f1.jpg');
    });
    assert.strictEqual(f1s.length, 2,
        'the dead completion stayed dead — the want re-admitted fresh');
    f1s[f1s.length - 1].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f1.jpg'),
        'only the fresh preparation paints');
}

// An authored rep the current selection has outgrown is no proof to
// wait on either: the measured need selects a sharper rung, so the
// request carries that rung directly — the intermediate rep is never
// a preparation step the author ordered. Held unsettled, the selected
// op still suppresses everything behind it.
async function outgrownAuthoredRepDoesNotRedirectAdmission() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("u1280.jpg")'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450, upgrades: [
                {src: 'u1280.jpg', width: 1280, height: 720},
                {src: 'u1600.jpg', width: 1600, height: 900}
            ]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const first = stack.images[0];
    assert.strictEqual(presented(first), url('u1600.jpg'),
        'the first preparation is the selected rep — not the authored one it outgrew');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1280.jpg');
    }).length, 0, 'the outgrown authored rep is never a module request');
    // Held unsettled, the selected op still suppresses: further passes
    // mint neither a second selected request nor the authored rung.
    stack.driver.tick(32);
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 1, 'the held op is the one request');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1280.jpg');
    }).length, 0, 'still no intermediate preparation behind it');
    first.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('u1600.jpg') + '")',
        'the selected rep sharpens the paint it was chosen for');
}

// A held proof operation suppresses every twin: while the eligible
// authored rep's own request is physically outstanding, no second
// request for it and no base fetch behind it may start — the settle
// that proves it is the only arrival the standing rep ever gets.
async function heldProofSuppressesRepreparation() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {'background-image': 'url("u1600.jpg")'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'u1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(proof, 'the eligible displayed rep proves at its own rung');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    }).length, 0, 'no base fetch behind the held proof');
    // Passes while the proof is outstanding change nothing.
    stack.driver.tick(32);
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 1, 'the held proof is never re-requested');
    proof.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    }).length, 1, 'the proven rep is not re-requested either');
}

// The satisfied gate must not repaint a healthy standing frame with a
// narrower tier: the authored 1600² image is healthy at cap 800, the
// selected 800² rep funds member zero, the gate opens — and the
// standing URL is still the authored one. The narrowing belongs to
// the upgrade path's own rules, and only a failed displayed source
// earns it.
async function gateOpenNeverDowngradesTheStandingImg() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    const {stack, scope} = declaredPage({
        host: host,
        baseline: 'u1600.jpg',
        resolution: true,
        scrubBuffer: 1,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u1600.jpg', width: 1600, height: 1600}]
                };
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const s0 = stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    })[0];
    assert.ok(s0, 'the cap-compliant rep is what member zero prepares');
    s0.succeed(800, 800);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the funded gate opens — the healthy standing image is never narrowed');
    // Cap-compliant changes to another frame still work.
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    scrollFraction(stack, scope, 1000); // desired 1
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('s1.jpg'),
        'the other frame commits its own ready rep');
}

// The same rule on a background host — the authored stylesheet image
// is the presentation, and a gate opening on its ready member never
// rewrites it with the narrower rep.
async function gateOpenNeverDowngradesTheStandingBackground() {
    FakeSubscription.reset();
    const host = new Element('i', 'host');
    host.computedStyle = {
        'background-image': 'url("u1600.jpg")',
        '--paste-resolution-max-width': '800'
    };
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        scrubBuffer: 1,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u1600.jpg', width: 1600, height: 1600}]
                };
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const s0 = stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    })[0];
    assert.ok(s0, 'the cap-compliant rep is what member zero prepares');
    s0.succeed(800, 800);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'the funded gate opens — the authored presentation is never narrowed');
    stack.images.forEach(function (image) {
        if (image.src === url('s1.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    scrollFraction(stack, scope, 1000); // desired 1
    stack.driver.tick(48);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('s1.jpg') + '")',
        'the other frame commits its own ready rep');
}

// A cap reduction inside a closed gate is the same boundary: the
// standing rep was eligible when it proved, the cap that later
// excludes it changes nothing about which tier may replace it — a
// satisfied member opens the gate and the healthy standing image
// still stands.
async function capReductionDuringClosedGateNeverDowngrades() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, scope} = declaredPage({
        host: host,
        baseline: 'u1600.jpg',
        resolution: true,
        scrubBuffer: 1,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u1600.jpg', width: 1600, height: 1600}]
                };
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const u1600 = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(u1600, 'the eligible authored rep proves at its own rung');
    u1600.succeed(1600, 1600);
    await settlePromises();
    stack.driver.tick(32);
    // The cap closes over the standing rep while its member waits:
    // the selected tier drops to the base, the gate still owes its
    // member — and its opening changes nothing about the paint.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    const s0 = stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    })[0];
    assert.ok(s0, 'the newly selected rep prepares inside the closed gate');
    stack.images.forEach(function (image) {
        if (image.src === url('s0.jpg') || image.src === url('s1.jpg')) {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u1600.jpg'),
        'the cap-reduced gate opens — the healthy standing image is never narrowed');
    scrollFraction(stack, scope, 1000); // desired 1
    stack.driver.tick(80);
    stack.images.forEach(function (image) {
        if (image.src === url('s2.jpg')) { image.succeed(800, 800); }
    });
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('s1.jpg'),
        'the other frame commits its own cap-compliant rep');
}

// The repair exception at the same boundary: the displayed rep's own
// source is dead, so the satisfied member's narrower tier does paint —
// a smaller honest image beats a broken one.
async function gateOpenStillRepairsTheFailedStanding() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack} = declaredPage({
        host: host,
        baseline: 'u1600.jpg',
        resolution: true,
        scrubBuffer: 1,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            if (index === 0) {
                return {
                    src: 's0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u1600.jpg', width: 1600, height: 1600}]
                };
            }
            return {src: 's' + index + '.jpg', width: 800, height: 800, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    const u1600 = stack.images.filter(function (image) {
        return image.src === url('u1600.jpg');
    })[0];
    assert.ok(u1600, 'the displayed rep owes its decode proof');
    u1600.fail();
    await settlePromises();
    stack.driver.tick(32);
    const s0 = stack.images.filter(function (image) {
        return image.src === url('s0.jpg');
    })[0];
    assert.ok(s0, 'the surviving rep is the member\'s funding');
    stack.images.forEach(function (image) {
        if (image.src === url('s0.jpg') || image.src === url('s1.jpg')) {
            image.succeed(800, 800);
        }
    });
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('s0.jpg'),
        'the dead standing source yields to the narrower repair');
}

// The single-frame exception also covers recovery: a standing
// representation that alone outspends the budget must not deny the
// mandatory ungated replacement that returns the sequence under
// budget. Shrinking the surface re-selects a small tier; the next
// desire cannot fit beside the oversized paint, yet it is the only
// work that can — refusing it would be a permanent denial.
async function oversizedStandingRecoversThroughSmallerReplacement() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        // The oversized standing is the authored baseline itself —
        // 4096×2304 ≈ 37.7 MB decoded, over the budget alone.
        baseline: 'u4096.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('u4096.jpg')],
        'the adopted oversized baseline owes its decode proof — nothing else fits beside it');
    stack.images[0].succeed(4096, 2304);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('u4096.jpg'),
        'the oversized authored baseline stands painted');

    // The surface shrinks: selection is now the 800-wide base.
    host.rect = {top: 0, bottom: 900, left: 0, right: 400, width: 400, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);

    scrollFraction(stack, scope, 1200); // progress .4 → desired 2
    stack.driver.tick(48);
    const small = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(small,
        'the smaller mandatory replacement admits despite the oversized standing');
    small.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the replacement paints and retires the oversized standing');
}

// While the recovery replacement is physically outstanding the
// oversized standing keeps painting — it is the presentation until
// the replacement has actually decoded.
async function oversizedRecoveryKeepsTheStandingWhileHeld() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'u4096.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(4096, 2304); // the baseline's proof
    await settlePromises();
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 900, left: 0, right: 400, width: 400, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);

    scrollFraction(stack, scope, 1200); // desired 2
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('u4096.jpg'),
        'the oversized paint stands while its replacement is in flight');
    assert.strictEqual(stack.images.length, 2,
        'one bounded recovery operation — no burst beside it');
    stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the held replacement paints on settle');
}

// Desires that change while a recovery operation is outstanding
// coalesce: the allowance is one operation whatever its size, so a
// mid-hold desire admits nothing — the latest useful desire is what
// the freed allowance takes on settle.
async function oversizedRecoveryCoalescesDesiresDuringHold() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'u4096.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(4096, 2304); // the baseline's proof
    await settlePromises();
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 900, left: 0, right: 400, width: 400, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);

    scrollFraction(stack, scope, 1200); // desired 2 — the recovery fetch
    stack.driver.tick(64);
    scrollFraction(stack, scope, 1300); // desired 3 — must coalesce, not admit
    stack.driver.tick(80);
    scrollFraction(stack, scope, 1500); // desired 4 — the latest desire
    stack.driver.tick(96);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('f2.jpg'), url('u4096.jpg')].sort(),
        'the outstanding recovery spends the one allowance — later desires wait');
    stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(112);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('f2.jpg'), url('f4.jpg'), url('u4096.jpg')].sort(),
        'the settle admits the latest desire alone — the intermediates never ran');
}

// Optional work never spends the allowance: an oversized standing is
// recoverable only by the mandatory ungated replacement, so the
// speculation the window carries stays refused — an optional
// same-index sharpen included — and a gated member keeps the set's
// own accounting.
async function speculationNeverSpendsTheException() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: 'u4096.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    // The surface shrinks and the document finishes loading: optional
    // work is admissible in principle now, but nothing optional can
    // fit beside the oversized paint and none may use the exception.
    host.rect = {top: 0, bottom: 900, left: 0, right: 400, width: 400, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.window.fireEvent('load');
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('u4096.jpg')],
        'neither speculation nor an optional sharpen spends the allowance');
}

// Control for the recovery case: the same catalog and oversized
// standing under the geometry that selected it still takes the next
// oversized desire — the sequence is not wedged, only denied work
// that cannot help it return under budget.
async function oversizedStandingStillTakesAnOversizedDesired() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 'u4096-0.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index < 2 ?
                    [{src: 'u4096-' + index + '.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('u4096-0.jpg');
    })[0].succeed(4096, 2304); // the baseline's proof
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('u4096-0.jpg'),
        'the oversized authored baseline stands painted');

    // Desired 1's oversized rep admits through the same allowance.
    scrollFraction(stack, scope, 1050); // progress .25 → desired 1
    stack.driver.tick(48);
    const next = stack.images.filter(function (image) {
        return image.src === url('u4096-1.jpg');
    })[0];
    assert.ok(next, 'the next oversized mandatory frame admits');
    next.succeed(4096, 2304);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('u4096-1.jpg'),
        'the oversized replacement paints');
}

// The standing rep is priced into the gated set like anything else:
// a positive buffer over an oversized standing cannot fund its
// members, the gate stays closed, and the exception's ungated reach
// never applies to required work.
async function oversizedStandingKeepsThePositiveGateClosed() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, scope} = declaredPage({
        host: host,
        baseline: 'u4096.jpg',
        resolution: true,
        scrubBuffer: 1,
        hostRect: {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    host.rect = {top: 0, bottom: 900, left: 0, right: 400, width: 400, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);

    scrollFraction(stack, scope, 1300); // desired 3 — gated set {3,4}
    stack.driver.tick(64);
    await settlePromises();
    stack.driver.tick(80);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).filter(function (src) {
            return src !== url('u4096.jpg');
        }),
        [],
        'the unfundable gated set admits no member');
    assert.strictEqual(presented(host), url('u4096.jpg'),
        'the oversized standing still paints behind the closed gate');
}

// One complete URL is one resource however many authored indices name
// it: the whole gate shares the single pending operation, and the
// landed image readies every alias together — the buffer opens on the
// settle alone, no extra scroll, no second request.
async function sharedUrlBufferOpensOnOneOperation() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        scrubBuffer: 6,
        catalogDocument: {frames: Array.from({length: 10}, function () {
            return {src: 'shared.jpg', width: 2000, height: 1000, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('shared.jpg')],
        'six authored indices naming one URL share a single operation');
    stack.images[0].succeed(2000, 1000);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('shared.jpg'),
        'the landed resource readies every alias and opens the gate');
}

// A,A,A,B: the shared resource satisfies its three aliases at once —
// and the gate still waits for the distinct member it never claimed.
async function distinctAliasMemberStillHoldsTheGate() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 4,
        catalogDocument: {frames: [
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'b.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }).sort(),
        [url('a.jpg'), url('b.jpg')],
        'each distinct resource holds exactly one operation');
    stack.images.filter(function (image) {
        return image.src === url('a.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'three satisfied aliases do not open a gate still missing b');
    stack.images.filter(function (image) {
        return image.src === url('b.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('a.jpg'),
        'the complete set opens on the desired frame');
}

// The same complete URL carrying two different intrinsic sizes is
// malformed metadata — the host falls back to its baseline, requests
// nothing, and costs a sound sibling nothing either.
async function conflictingAliasDimensionsRejectTheHost() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const bad = new Element('img', 'bad');
    bad.src = 'b0.jpg';
    bad.setAttribute('data-paste-imagesequence', '#frames-bad');
    const good = new Element('img', 'good');
    good.src = 'g0.jpg';
    good.setAttribute('data-paste-imagesequence', '#frames-good');
    scope.appendChild(bad);
    scope.appendChild(scriptJson('frames-bad', {frames: [
        {src: 'x.jpg', width: 800, height: 450, upgrades: []},
        {src: 'x.jpg', width: 1600, height: 900, upgrades: []},
        {src: 'y.jpg', width: 800, height: 450, upgrades: []}
    ]}));
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames-good', catalog(2)));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    assert.strictEqual(presented(bad), url('b0.jpg'),
        'the conflicting catalog leaves its host at the baseline');
    assert.ok(stack.images.every(function (image) {
        return image.src !== url('x.jpg') && image.src !== url('y.jpg');
    }), 'the malformed host never issues a request');
    assert.ok(stack.images.some(function (image) {
        return image.src === url('f1.jpg');
    }), 'the sound sibling still binds and prepares');
}

// A dead URL is dead for every alias that names it — remembered by
// source, retried by nobody — while the surviving member still paints
// when the live scroll asks for it.
async function deadSharedUrlDeadensEveryAlias() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 4,
        catalogDocument: {frames: [
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'a.jpg', width: 800, height: 450, upgrades: []},
            {src: 'b.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('a.jpg');
    })[0].fail();
    await settlePromises();
    stack.driver.tick(32);
    stack.images.filter(function (image) {
        return image.src === url('b.jpg');
    })[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    scrollFraction(stack, scope, 1800); // desired 3 — the live member
    stack.driver.tick(64);
    assert.strictEqual(
        stack.images.filter(function (image) {
            return image.src === url('a.jpg');
        }).length, 1,
        'a dead shared URL is never retried for its other aliases');
    assert.strictEqual(presented(host), url('b.jpg'),
        'the surviving member still paints its frame');
}

// The authored URL appearing at frame zero and again later adopts the
// first match — the declared initial pose — never the loop's last.
// Reduced motion sharpens only the initial pose: a mis-assigned index
// finds no upgrade and stays silent.
async function authoredUrlAdoptsTheFirstMatchingIndex() {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const host = new Element('img', 'host');
    const {stack} = declaredPage({
        host: host,
        baseline: 'pose.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
        window: {matchMedia: function () { return motion; }},
        catalogDocument: {frames: [
            {src: 'pose.jpg', width: 800, height: 450,
                upgrades: [{src: 'pose-2x.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'pose.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) {
        return image.src === url('pose.jpg');
    })[0];
    assert.ok(proof, 'the authored pose owes its decode proof');
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    // The surface grows: a sharper rung of the standing pose is now
    // selectable — only the frame-zero identity carries the upgrade.
    host.rect = {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    await settlePromises();
    stack.driver.tick(64);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('pose-2x.jpg');
    }), 'the proven initial pose sharpens — the first match kept its index');
}

// A displayed, proven frame whose selection outgrew it is ordinary
// optional sharpening — never mandatory work. The oversized-frame
// allowance exists for the frame the page needs, not for refinement:
// an oversized optional rung is refused outright.
async function optionalSharpenNeverSpendsTheException() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack} = declaredPage({
        host: host,
        baseline: 'f0.jpg',
        resolution: true,
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {
                src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: index === 0 ?
                    [{src: 'u4096.jpg', width: 4096, height: 2304}] : []
            };
        })}
    });
    stack.driver.tick(16);
    stack.images.filter(function (image) {
        return image.src === url('f0.jpg');
    })[0].succeed(800, 450); // the displayed rep proves itself
    await settlePromises();
    stack.driver.tick(32);
    // The selection now outgrows the proven paint: a sharpen to the
    // oversized tier is optional work, and optional work never spends
    // the exceptional allowance.
    host.rect = {top: 0, bottom: 900, left: 0, right: 2000, width: 2000, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(stack.images.every(function (image) {
        return image.src !== url('u4096.jpg');
    }), true, 'the oversized optional rung is refused — the allowance is mandatory-only');
}

// A scope with no rendered box is not a range at 0 — it is no range at
// all: nothing prepares and nothing paints until a real measure says
// otherwise.
async function unrenderedScopeKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({scopeClientRects: []});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0}; // still unrendered
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0,
        'an unrendered subject admits nothing');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the baseline stands untouched');
    scope.clientRects = undefined; // rendered again
    scope.rect = {top: 1600 - 1300, bottom: 1800 - 1300, width: 100, height: 200};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(stack.images.length > 0,
        'the scene prepares once it actually renders');
}

// A completion that lands while the host has no rendered box is parked
// evidence, not a paint: it waits out the ineligible pass and commits
// on the first measurable one — the last honest presentation stands
// throughout.
async function parkedCompletionPaintsOnlyWhenTheHostMeasures() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, scope} = declaredPage({host: host});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // desired 2
    stack.driver.tick(32);
    const wanted = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(wanted, 'the desired frame is in flight');
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    wanted.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'nothing paints while the host has no rendered box');
    host.rect = {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'the parked result paints once the host measures again');
}

// A running intro whose host loses its rendered box ends at once —
// the skip retires, the handler disposes, and a later measurable pass
// never replays what the withdrawal already ended.
async function hostLosingItsBoxEndsTheIntro() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const {stack, skip} = declaredPage({
        host: host,
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro is playing');
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'losing the rendered box ends the intro on the spot');
    host.rect = {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    stack.driver.tick(4000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'measurable again is not a reason to replay');
}

// A declared skip that cannot be owned is malformed markup: the whole
// host stays at its authored baseline — no intro clock, no scrubbing,
// not one request — and the module reports it once, as a TypeError
// rethrown on a later task.
async function assertIntroDroppedScrollBinds(stack, scope, host) {
    stack.driver.tick(1200);
    await settleAll(stack.images);
    stack.driver.tick(1300);
    assert.strictEqual(presented(host), url('f0.jpg'), 'an intro clock ran despite the unusable skip');
    scrollFraction(stack, scope, 1300); // progress 0.5 would be frame 2
    stack.driver.tick(1400);
    await settleAll(stack.images);
    stack.driver.tick(1500);
    assert.strictEqual(presented(host), url('f0.jpg'), 'a host with malformed skip markup still scrubbed');
    assert.strictEqual(stack.images.length, 0, 'a host with malformed skip markup requested frames');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 1, 'the malformed host is reported exactly once');
    assert.ok(reports[0] instanceof TypeError || reports[0].name === 'TypeError',
        'the report is a descriptive TypeError');
    assert.ok(/sequence-intro-skip/.test(reports[0].message), 'the report names the declaration');
}

// A declared skip that resolves to no usable control is malformed: the
// author never got to make the intro skippable, so the whole host stays
// static and is reported. The named element is untouched.
async function nonButtonSkipLeavesTheBaseline() {
    FakeSubscription.reset();
    const anchor = new Element('a', 'skip');
    anchor.setAttribute('hidden', '');
    const {stack, scope, host} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipElement: anchor
    });
    stack.driver.tick(16);
    await assertIntroDroppedScrollBinds(stack, scope, host);
    assert.strictEqual(anchor.hasAttribute('hidden'), true,
        'the rejected control is untouched');
    assert.ok(FakeSubscription.registry.every(function (subscription) {
        return subscription.target !== anchor;
    }), 'and it owns no click handler');
}

// A button whose effective type is submit is the same unusable skip —
// no unskippable intro plays, and the host stays static.
async function submitSkipLeavesTheBaseline() {
    FakeSubscription.reset();
    const submit = new Element('button', 'skip');
    submit.setAttribute('type', 'submit');
    submit.setAttribute('hidden', '');
    const {stack, scope, host} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipElement: submit
    });
    stack.driver.tick(16);
    await assertIntroDroppedScrollBinds(stack, scope, host);
    assert.strictEqual(submit.hasAttribute('hidden'), true,
        'the rejected control is untouched');
    assert.ok(FakeSubscription.registry.every(function (subscription) {
        return subscription.target !== submit;
    }), 'and no handler binds to it');
}

// A control that was never authored hidden cannot be shown "back":
// the host stays static.
async function visibleSkipLeavesTheBaseline() {
    FakeSubscription.reset();
    const visible = new Element('button', 'skip');
    visible.setAttribute('type', 'button');
    const {stack, scope, host} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipElement: visible
    });
    stack.driver.tick(16);
    await assertIntroDroppedScrollBinds(stack, scope, host);
    assert.strictEqual(visible.hasAttribute('hidden'), false,
        'the visible control keeps its authored visibility');
    assert.ok(FakeSubscription.registry.every(function (subscription) {
        return subscription.target !== visible;
    }), 'and it is never claimed');
}

// A selector naming zero controls is malformed: the host whose skip can
// never exist stays static.
async function missingSkipTargetLeavesTheBaseline() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#nothing-here'}
    });
    stack.driver.tick(16);
    await assertIntroDroppedScrollBinds(stack, scope, host);
}

// A selector naming more than one control is ambiguous — never
// first-come: the host stays static.
async function ambiguousSkipSelectorLeavesTheBaseline() {
    FakeSubscription.reset();
    const first = new Element('button', 'skip-one');
    first.setAttribute('type', 'button');
    first.setAttribute('hidden', '');
    first.className = 'skips';
    const second = new Element('button', 'skip-two');
    second.setAttribute('type', 'button');
    second.setAttribute('hidden', '');
    second.className = 'skips';
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const host = new Element('img', 'host');
    host.src = 'f0.jpg';
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.setAttribute('data-sequence-intro-duration-ms', '3000');
    host.setAttribute('data-sequence-intro-easing', 'linear');
    host.setAttribute('data-sequence-intro-skip', '.skips');
    scope.appendChild(host);
    scope.appendChild(scriptJson('frames', catalog(4)));
    scope.appendChild(first);
    scope.appendChild(second);
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await assertIntroDroppedScrollBinds(stack, scope, host);
    assert.strictEqual(first.hasAttribute('hidden'), true, 'neither control is claimed');
    assert.strictEqual(second.hasAttribute('hidden'), true, 'the ambiguous selector stays inert');
}

// Two sequences naming one control is a conflict, not a race: the
// control cannot serve two owners, so both hosts stay at their
// baselines — DOM order never picks a winner — and each is reported.
async function sharedSkipControlInertsBoth() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const hostA = new Element('img', 'hero-a');
    hostA.src = 'f0.jpg';
    hostA.setAttribute('data-paste-imagesequence', '#frames-a');
    hostA.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostA.setAttribute('data-sequence-intro-easing', 'linear');
    hostA.setAttribute('data-sequence-intro-skip', '#shared-skip');
    const hostB = new Element('img', 'hero-b');
    hostB.src = 'f0.jpg';
    hostB.setAttribute('data-paste-imagesequence', '#frames-b');
    hostB.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostB.setAttribute('data-sequence-intro-easing', 'linear');
    hostB.setAttribute('data-sequence-intro-skip', '#shared-skip');
    const shared = new Element('button', 'shared-skip');
    shared.setAttribute('type', 'button');
    shared.setAttribute('hidden', '');
    scope.appendChild(hostA);
    scope.appendChild(scriptJson('frames-a', catalog(4)));
    scope.appendChild(hostB);
    scope.appendChild(scriptJson('frames-b', catalog(4)));
    scope.appendChild(shared);
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(1200);
    await settleAll(stack.images);
    stack.driver.tick(1300);
    assert.strictEqual(presented(hostA), url('f0.jpg'), 'the first host played a contested intro');
    assert.strictEqual(presented(hostB), url('f0.jpg'), 'the second host played a contested intro');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(1400);
    await settleAll(stack.images);
    stack.driver.tick(1500);
    assert.strictEqual(presented(hostA), url('f0.jpg'), 'the first contested host scrubbed');
    assert.strictEqual(presented(hostB), url('f0.jpg'), 'the second contested host scrubbed');
    assert.strictEqual(stack.images.length, 0, 'a contested host requested frames');
    assert.strictEqual((await reportsAfterATurn(stack.reports)).length, 2,
        'each contested host is reported once');
    assert.strictEqual(shared.hasAttribute('hidden'), true,
        'the contested control is never touched');
    assert.ok(FakeSubscription.registry.every(function (subscription) {
        return subscription.target !== shared;
    }), 'and no sequence binds a handler to it');
}

// The conflict is scoped to the contested control: a third sequence
// with a skip no one else declares plays normally beside the two
// inert ones.
async function conflictingSkipsSpareUnrelatedOwners() {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const hostA = new Element('img', 'hero-a');
    hostA.src = 'f0.jpg';
    hostA.setAttribute('data-paste-imagesequence', '#frames-a');
    hostA.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostA.setAttribute('data-sequence-intro-easing', 'linear');
    hostA.setAttribute('data-sequence-intro-skip', '#shared-skip');
    const hostB = new Element('img', 'hero-b');
    hostB.src = 'f0.jpg';
    hostB.setAttribute('data-paste-imagesequence', '#frames-b');
    hostB.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostB.setAttribute('data-sequence-intro-easing', 'linear');
    hostB.setAttribute('data-sequence-intro-skip', '#shared-skip');
    const hostC = new Element('img', 'hero-c');
    hostC.src = 'f0.jpg';
    hostC.setAttribute('data-paste-imagesequence', '#frames-c');
    hostC.setAttribute('data-sequence-intro-duration-ms', '3000');
    hostC.setAttribute('data-sequence-intro-easing', 'linear');
    hostC.setAttribute('data-sequence-intro-skip', '#own-skip');
    const shared = new Element('button', 'shared-skip');
    shared.setAttribute('type', 'button');
    shared.setAttribute('hidden', '');
    const own = new Element('button', 'own-skip');
    own.setAttribute('type', 'button');
    own.setAttribute('hidden', '');
    scope.appendChild(hostA);
    scope.appendChild(scriptJson('frames-a', catalog(4)));
    scope.appendChild(hostB);
    scope.appendChild(scriptJson('frames-b', catalog(4)));
    scope.appendChild(hostC);
    scope.appendChild(scriptJson('frames-c', catalog(4)));
    scope.appendChild(shared);
    scope.appendChild(own);
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(shared.hasAttribute('hidden'), true,
        'the contested control stays untouched');
    assert.strictEqual(presented(hostA), url('f0.jpg'), 'a conflicting host stays at baseline');
    assert.strictEqual(presented(hostB), url('f0.jpg'), 'the other conflicting host too');
    assert.strictEqual(own.hasAttribute('hidden'), false,
        'the uncontested declaration reveals its skip');
    assert.strictEqual((await reportsAfterATurn(stack.reports)).length, 2,
        'only the two contested hosts are reported');
}

// The retire restores what the page authored, byte for byte: a
// `hidden="hidden"` control goes back to `hidden="hidden"`, not to
// the module's own spelling of it.
async function skipRestoresItsAuthoredHiddenValue() {
    FakeSubscription.reset();
    const authored = new Element('button', 'skip');
    authored.setAttribute('type', 'button');
    authored.setAttribute('hidden', 'hidden');
    const {stack} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipElement: authored
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(authored.hasAttribute('hidden'), false, 'the intro reveals it');
    authored.fireEvent('click');
    stack.driver.tick(48);
    assert.strictEqual(authored.getAttribute('hidden'), 'hidden',
        'the authored hidden state returns verbatim');
}

// The skip's click handler lives only while the intro it skips is
// live: not at bind, not during the wait, and gone on every exit.
async function skipSubscriptionLivesOnlyWithTheIntro() {
    FakeSubscription.reset();
    const {stack, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    const live = function () {
        return FakeSubscription.registry.filter(function (subscription) {
            return subscription.target === skip && !subscription.disposed;
        }).length;
    };
    stack.driver.tick(16);
    assert.strictEqual(live(), 0,
        'a waiting intro has no active skip handler');
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro started');
    assert.strictEqual(live(), 1, 'the playing intro owns the handler');
    skip.fireEvent('click');
    stack.driver.tick(48);
    assert.strictEqual(live(), 0, 'and the handler leaves with the phase');
}

// The module header's example markup is the authoritative fixture:
// its data-* attributes are lifted straight out of the JSDoc block —
// the declared start, the intro's full authoring, the buffer and the
// scrub range — and the page it describes must actually play.
function documentedExampleDeclaration() {
    const fs = require('fs');
    const path = require('path');
    // The example contract lives in the documented source — the module
    // under test may be the manifest's minified selection, whose comments
    // are gone by construction, so the unminified module beside this
    // suite is the read (it travels with the tests in every channel).
    const source = fs.readFileSync(
        path.join(__dirname, '../modules/imagesequence/imagesequence.js'), 'utf8');
    const section = /data-paste-scrollscrub([\s\S]*?)<i class="product-visual"([\s\S]*?)aria-hidden="true"><\/i>/.exec(source);
    assert.ok(section, 'the documented section markup is present in the header');
    const attributes = function (text) {
        const found = {};
        const pattern = /data-([a-z-]+)="([^"]*)"/g;
        let match = pattern.exec(text);
        while (match) {
            found[match[1]] = match[2];
            match = pattern.exec(text);
        }
        return found;
    };
    return {scope: attributes(section[1]), visual: attributes(section[2])};
}

async function documentedExamplePlaysFromVerbatimMarkup() {
    FakeSubscription.reset();
    const declared = documentedExampleDeclaration();
    assert.strictEqual(declared.scope['scrub-start'], 'top top',
        'the documented traverse starts at the section top');
    const scope = new Element('section', 'product');
    scope.setAttribute('data-paste-scrollscrub', '');
    Object.keys(declared.scope).forEach(function (name) {
        scope.setAttribute('data-' + name, declared.scope[name]);
    });
    const visual = new Element('i', 'product-visual');
    Object.keys(declared.visual).forEach(function (name) {
        if (name === 'paste-ui-imagesequence') {
            visual.setAttribute('data-' + name, '#product-frames');
        } else {
            visual.setAttribute('data-' + name, declared.visual[name]);
        }
    });
    visual.setAttribute('aria-hidden', 'true');
    visual.computedStyle = {
        'background-image': 'url("/images/product-0-640.webp")',
        'background-size': 'cover'
    };
    const skip = new Element('button', 'product-intro-skip');
    skip.setAttribute('type', 'button');
    skip.setAttribute('hidden', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(visual);
    scope.appendChild(skip);
    scope.appendChild(scriptJson('product-frames', {frames: [
        {src: '/images/product-0-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-0-1280.webp',
                width: 1280, height: 1280}]},
        {src: '/images/product-1-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-1-1280.webp',
                width: 1280, height: 1280}]},
        {src: '/images/product-2-640.webp', width: 640, height: 640,
            upgrades: [{src: 'https://images-b.example.com/product-2-1280.webp',
                width: 1280, height: 1280}]}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the authored skip stays hidden while the buffer prepares');
    // The documented buffer holds more than the opening frame — every
    // member lands before the intro may start.
    const opening = stack.images.filter(function (image) {
        return image.src === 'http://localhost/images/product-0-640.webp';
    })[0];
    assert.ok(opening, 'the opening frame is demanded');
    const second = stack.images.filter(function (image) {
        return image.src === 'http://localhost/images/product-1-640.webp';
    })[0];
    assert.ok(second, 'the documented buffer demands the next member too');
    opening.succeed(640, 640);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the intro still waits — the authored buffer is not one frame');
    second.succeed(640, 640);
    await settleAll(stack.images, 640, 640);
    stack.driver.tick(48);
    assert.strictEqual(skip.hasAttribute('hidden'), false,
        'the complete buffer starts the intro');
    assert.strictEqual(
        stack.window.getComputedStyle(visual)
            .getPropertyValue('background-image'),
        'url("/images/product-0-640.webp")',
        'the intro opens on the authored first frame — already painted');
    // The declared run plays the authored progression — ease-in-out at
    // half duration crosses the midpoint pose — then hands reverse
    // scroll ownership at the end.
    stack.driver.tick(1248);
    assert.strictEqual(
        visual.style.getPropertyValue('background-image'),
        'url("http://localhost/images/product-1-640.webp")',
        'the declared easing reaches the midpoint frame');
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(2500);
    await settleAll(stack.images, 640, 640);
    stack.driver.tick(2600);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'the authored skip retires with the intro');
}

// The negative control beside it: the same page, the same requests —
// but one required member held back. If the intro started anyway the
// oracle must call it out; a run that never happened is not a pass.
async function documentedExampleNeverStartsWithoutTheBuffer() {
    FakeSubscription.reset();
    const scope = new Element('section', 'product');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-start', 'top top');
    scope.setAttribute('data-scrub-end', 'bottom top');
    const visual = new Element('i', 'product-visual');
    visual.setAttribute('data-paste-imagesequence', '#product-frames');
    visual.setAttribute('data-sequence-intro-from', '0');
    visual.setAttribute('data-sequence-intro-to', '2');
    visual.setAttribute('data-sequence-intro-duration-ms', '2400');
    visual.setAttribute('data-sequence-intro-buffer-ms', '1000');
    visual.setAttribute('data-sequence-intro-easing', 'ease-in-out');
    visual.setAttribute('data-sequence-intro-skip', '#product-intro-skip');
    visual.setAttribute('data-sequence-from', '2');
    visual.setAttribute('data-sequence-to', '0');
    visual.setAttribute('data-paste-progressiveresolution', '');
    visual.setAttribute('aria-hidden', 'true');
    visual.computedStyle = {
        'background-image': 'url("/images/product-0-640.webp")',
        'background-size': 'cover'
    };
    const skip = new Element('button', 'product-intro-skip');
    skip.setAttribute('type', 'button');
    skip.setAttribute('hidden', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(visual);
    scope.appendChild(skip);
    scope.appendChild(scriptJson('product-frames', {frames: [
        {src: '/images/product-0-640.webp', width: 640, height: 640, upgrades: []},
        {src: '/images/product-1-640.webp', width: 640, height: 640, upgrades: []},
        {src: '/images/product-2-640.webp', width: 640, height: 640, upgrades: []}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    // Land the opening frame but hold the buffered member — the intro
    // must not start on partial readiness.
    stack.images.filter(function (image) {
        return image.src === 'http://localhost/images/product-0-640.webp';
    })[0].succeed(640, 640);
    await settlePromises();
    stack.driver.tick(32);
    stack.driver.tick(3000);
    assert.strictEqual(skip.hasAttribute('hidden'), true,
        'a held member keeps the authored skip hidden');
    assert.strictEqual(
        visual.style.getPropertyValue('background-image'), '',
        'and no commit ever wrote over the authored baseline');
}

// Each case registers with the Node test runner under its function name.
test(baselineAdoptsThenNeighborsPrepare);
test(scrollCommitsTheDesiredFrame);
test(outOfOrderCompletionCommitsTheCurrentDesire);
test(failedFrameLeavesThePaint);
test(preparationStaysBounded);
test(hostWithoutScopeStaysInert);
test(missingCatalogStaysInert);
test(absentPromiseLeavesEveryHostAuthored);
test(backgroundImageHostPaints);
test(resolutionFlagSharpensTheDisplayedFrame);
test(capRestrictsOptionalUpgrades);
test(explicitRangeSamplesSubset);
test(reverseRangeRunsBackwards);
test(windowDeclaresThePlayableSpan);
test(introPlaysThenScrollOwns);
test(scrollDuringIntroHandsOff);
test(introSkipEndsPlayback);
test(currentPositionInitializationSkipsIntro);
test(reducedMotionKeepsTheBaseline);
test(saveDataDoesNotChangeEligibility);
test(hiddenDocumentEndsIntro);
test(missingIntroFramePermitsScroll);
test(lateIntroCompletionDoesNotRepaint);
test(relativeSourcesResolveAgainstTheDocumentBase);
test(preparationCarriesAuthoredCorsAttributes);
test(decodeRejectionKeepsTheBaseline);
test(loadFallbackCommitsWithoutDecode);
test(noDeclarationsStayQuiet);
test(restorePreservesTheAuthoredInlineBackground);
test(focusedSkipIsBlurredOnRetire);
test(reducedMotionMidFlightKeepsTheBaseline);
test(decodedBudgetCountsAllOwnedWork);
test(capacitySettleRetriesAWaitingUpgrade);
test(failedIntroFrameHandsScrollOwnership);
test(nativeSrcsetKeepsNativeOwnership);
test(sizesOnlyImgKeepsNativeOwnership);
test(objectFitCoverDemandsTheLargerCandidate);
test(intrinsicFitImgDemandsDensity);
test(sharedRootsShareInputSubscriptions);
test(supersededUpgradesKeepTheirPhysicalSlots);
test(resolutionGrowthKeepsEveryPendingOperation);
test(speculativeNeighborRespectsTheDecodedBudget);
test(cachedUpgradeRepRespectsTheCapOnRepaint);
test(lateUpgradeIsReconciledAtSettle);
test(outOfOrderUpgradeKeepsTheDisplayedAccounting);
test(offscreenSequenceDefersWorkUntilNear);
test(optionalWorkNeverWaitsForTheDocumentLoad);
test(leavingTheSceneReleasesTheCache);
test(postLeaveCompletionRetainsNothing);
test(collapsedRangeStopsAnActiveIntro);
test(collapsedRangeWithdrawsThePendingDesire);
test(passReadsCompleteBeforeWrites);
test(malformedEasingStaysInertAndNeighborsBind);
test(malformedCatalogJsonStaysInert);
test(documentedExamplePageBehavesAsAuthored);
test(documentedImgExampleBinds);
test(unreadyAuthoredFrameGatesTheIntroClock);
test(brokenAuthoredFrameSkipsTheIntro);
test(backgroundBaselineProvesItselfBeforeTheIntro);
test(degenerateRangeKeepsTheBaseline);
test(lateBaseKeepsTheSharperDisplayedEntry);
test(contemplatedSpeculationNeverBlocksDemand);
test(reducedMotionRefinesOnlyFrameZero);
test(switchingToReducedMotionStillRefines);
test(legacyAndInertMediaQueriesStillEnhance);
test(reducedMotionLeavesANonzeroPosterAlone);
test(unprovenBaselineKeepsIntroWaitingThroughLeaveAndReturn);
test(provenBaselineSurvivesRelease);
test(unprovenEntryCannotReplaceProvenFrameImg);
test(unprovenEntryCannotReplaceProvenFrameBackground);
test(provenBaselineIsNotRefetchedOnReturn);
test(proofLandingOutsideTheBandStillCounts);
test(committedUpgradeKeepsReadinessAcrossReturn);
test(backgroundUrlKeepsQuotedParentheses);
test(otherRepCompletionDoesNotProveDisplayed);
test(readyCachedRepPaintsWhenThePreferredRungMoves);
test(largerCachedRepPaintsAfterTheSmallerPreferred);
test(failedPreferredRungDoesNotVetoCachedImprovement);
test(authoredUpgradeIsAdoptedNotDowngraded);
test(unprovenAuthoredUpgradeProvesItself);
test(failedAdoptedRepLeavesTheBaseUsable);
test('failedAdoptedImgRepPaintsTheBase (false)', function () { return failedAdoptedImgRepPaintsTheBase(false); });
test('failedAdoptedImgRepPaintsTheBase (true)', function () { return failedAdoptedImgRepPaintsTheBase(true); });
test(suffixResemblanceIsNotAdoption);
test(overCapAdoptedRepNeverLoopsAsNeighbor);
test(capIneligibleDisplayedRepDoesNotRedirectAdmission);
test(optionalAdmissionPricesTheRequestedRep);
test(backForwardReturnSkipsAConsumedIntro);
test(backForwardReturnReplaysAnUnconsumedIntro);
test(recordedIntroDoesNotSuppressAnOrdinaryReload);
test(introRecordStaysScopedToItsPage);
test(idLessHostRecordsByOrdinal);
test(siblingIntrosRecordIndependently);
test(unavailableSessionStorageStillPlays);
test(scrollBeforeIntroProofPreventsTheIntro);
test(proofThenScrollBeforeOnePassPreventsTheIntro);
test(scrollBeforeTheFirstPassPreventsTheIntro);
test(nestedRootScrollBeforeProofPreventsTheIntro);
test(noScrollStillStartsTheIntro);
test(selectedTierIsTheRequestNotTheBase);
test(fullCacheReclaimResumesPreparation);
test(lookaheadLeadsTheDirectionOfTravel);
test(introLeadFollowsTheEasedHorizon);
test(displayedUpgradeReclaimsTheSpeculativeWindow);
test(introBufferHoldsTheClockUntilTheSetIsReady);
test(introBufferDeadlineAbandonsTheWaitOnce);
test(unmeasurableIntervalsKeepOneDeadline);
test(staleIntroWakeCannotRetireALiveWait);
test(restoreAfterDeadlineExpiryHandsToScroll);
test(infeasibleIntroBufferAbandonsTheIntro);
test(scrubBufferGatesChangesUntilTheSetIsReady);
test(scrubBufferClampsToTheEndpoint);
test(scrubGateReopensOnDirectionChange);
test(deadRequiredMemberDeniesTheSetOnce);
test(invalidBufferDeclarationsStayInert);
test(failedPreferredUpgradeFallsBackToSurvivingRung);
test(allUpgradeRungsDeadLeavesTheBaseline);
test(playingIntroLeadFollowsTimeNotAFrameCount);
test(playingIntroNeverDemandsTheScrollGateSet);
test(demandedFrameReclaimsExpendableRetained);
test(oversizedMandatoryFrameAdmitsAlone);
test(introPaintsTheSelectedRungOnStart);
test(closedGateDemandsItsSetOnSameIndexEntry);
test(closedGateReEvaluatesOnBandReentry);
test(closedGateReEvaluatesAfterInvalidRange);
test(introHandoffStillEvaluatesTheClosedGate);
test(standingImagePricesIntoBufferFeasibility);
test(sharedSourceCountsOnceInBufferFeasibility);
test(deniedGateAdmitsNothingOnBandEntry);
test(deadGateMemberDeniesUntilTheSetChanges);
test(zeroSizeHostStaysIdleUntilMeasurable);
test(zeroSizeHostIntroStaysWithdrawnAfterTakeover);
test(pendingAuthoredDecodeOpensNeitherGate);
test(rejectedAuthoredDecodeKeepsBothGatesClosed);
test(loadOnlyPlatformAdoptsAuthoredReadiness);
test(ordinaryDemandWaitsForOwnedCapacity);
test(obsoleteRequiredRepReleasesForItsReplacement);
test(capExcludedSurvivingRungEndsTheIntroWait);
test(disabledResolutionDeadBaseEndsTheIntroWait);
test(scrubGateRecoversAfterPolicyChange);
test(hiddenDocumentNeverArmsTheIntroWait);
test(hidingBetweenProofAndStartWithdraws);
test(scrubAdvanceHoldsForTheSelectedTier);
test(ordinarySharpeningFollowsTheFreshPolicy);
test(newPoseSharpeningAdmits);
test(requiredMemberSharpeningAdmits);
test(introAdvanceHoldsForTheSelectedTier);
test(failedSelectedRungPaintsTheSurvivingFallback);
test(retainedSharperRepPaintsWhenTheLadderIsExhausted);
test(capKeepsTheExhaustedGateClosed);
test(overqualifiedCacheRepricesForTheFeasibleGate);
test(sharperCacheKeptWhenTheSetAffordsIt);
test(infeasibleSelectedSetKeepsTheGateClosed);
test(oversizedReplacementCoalescesUntilSettle);
test(optionalWorkReservesTheUnfundedGate);
test(landedUpgradeNeverDisplacesTheClosedGate);
test(surplusCapacityPermitsOptionalSharpening);
test(movedDesireNeverSharpensTheStandingFrame);
test(pendingSharperRepReopensTheDeniedGate);
test(capIneligiblePendingRepIsExhaustion);
test(failedPendingRepIsExhaustion);
test(introWaitHoldsForAQualifyingPendingRep);
test(standingReuseFundsTheFeasibleMixture);
test(deferredUpgradeNeverLoopsPreparation);
test(blockedUpgradePreparesOnceWhileTheSetWaits);
test(smallerRepairReopensTheRequiredGate);
test(reversalPaintsTheFirstCompletedPreparation);
test(parkedCompletionNeverPaintsOverCap);
test(parkedCompletionStaysDeadUnderReducedMotion);
test(outgrownAuthoredRepDoesNotRedirectAdmission);
test(heldProofSuppressesRepreparation);
test(gateOpenNeverDowngradesTheStandingImg);
test(gateOpenNeverDowngradesTheStandingBackground);
test(capReductionDuringClosedGateNeverDowngrades);
test(gateOpenStillRepairsTheFailedStanding);
test(oversizedStandingRecoversThroughSmallerReplacement);
test(oversizedRecoveryKeepsTheStandingWhileHeld);
test(oversizedRecoveryCoalescesDesiresDuringHold);
test(speculationNeverSpendsTheException);
test(oversizedStandingStillTakesAnOversizedDesired);
test(oversizedStandingKeepsThePositiveGateClosed);
test(sharedUrlBufferOpensOnOneOperation);
test(distinctAliasMemberStillHoldsTheGate);
test(conflictingAliasDimensionsRejectTheHost);
test(deadSharedUrlDeadensEveryAlias);
test(authoredUrlAdoptsTheFirstMatchingIndex);
test(optionalSharpenNeverSpendsTheException);
test(unrenderedScopeKeepsTheBaseline);
test(parkedCompletionPaintsOnlyWhenTheHostMeasures);
test(hostLosingItsBoxEndsTheIntro);
test(nonButtonSkipLeavesTheBaseline);
test(submitSkipLeavesTheBaseline);
test(visibleSkipLeavesTheBaseline);
test(missingSkipTargetLeavesTheBaseline);
test(ambiguousSkipSelectorLeavesTheBaseline);
test(sharedSkipControlInertsBoth);
test(conflictingSkipsSpareUnrelatedOwners);
test(skipRestoresItsAuthoredHiddenValue);
test(skipSubscriptionLivesOnlyWithTheIntro);
test(documentedExamplePlaysFromVerbatimMarkup);
test(documentedExampleNeverStartsWithoutTheBuffer);

// A matchMedia that throws is an optional capability probe on a browser
// boundary: with no declared hosts it costs the page nothing, and with
// a declared sequence it costs the module its motion hint only — the
// declaration still binds.
test('a throwing matchMedia does not abort the factory with no declarations', function () {
    FakeSubscription.reset();
    const stack = openStack({
        elements: {},
        scrollscrub: false,
        imagesequence: true,
        window: {matchMedia: function () { throw new Error('matchMedia poisoned'); }}
    });
    assert.ok(stack.modules.imagesequence, 'the factory threw on a capability probe');
    assert.strictEqual(stack.driver.pending(), 0, 'no frames should be armed on an empty page');
});

function throwingMatchMediaStillBindsTheDeclaration() {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        window: {matchMedia: function () { throw new Error('matchMedia poisoned'); }}
    });
    stack.driver.tick(16);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'a poisoned motion probe left the baseline unadopted');
}

// A decode implementation that throws synchronously is a failed
// preparation: the op settles exactly once, the physical slot frees,
// and the next desired frame still gets its chance.
async function throwingDecodeFreesTheSlot() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    const first = stack.images[0];
    first.decode = function () { throw new Error('decode was wrapped'); };
    first.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    // The freed slot admits the next desired frame's preparation.
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    assert.ok(f2, 'the thrown decode stranded its slot — no further preparation ran');
}

// A poisoned observer constructor retires resize-driven re-measure only
// — the scroll-driven frame selection the declaration already owns
// keeps working.
async function poisonedObserverKeepsScrollSelection() {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        window: {ResizeObserver: function () { throw new Error('observer poisoned'); }}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(48);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'a poisoned observer cost the sequence its scroll-driven selection');
}

test(throwingMatchMediaStillBindsTheDeclaration);
test(throwingDecodeFreesTheSlot);
test(poisonedObserverKeepsScrollSelection);

// Two scenes waiting through the same passes each own their deadline:
// a wake armed inside the shared pass must carry its own sequence —
// closing over the pass loop's variables hands every expiring timer
// to whichever scene ran last. Fire both bounds and only the scene a
// timer was armed for may leave its wait; the other keeps waiting
// until its own bound lands.
async function siblingIntroDeadlinesActOnTheirOwnScenes() {
    FakeSubscription.reset();
    const timers = [];
    const makeSequence = function (name) {
        const scope = new Element('div', name + 'scope');
        scope.setAttribute('data-paste-scrollscrub', '');
        const host = new Element('img', name + 'host');
        host.setAttribute('data-paste-imagesequence', '#' + name + 'frames');
        host.src = name + 'f0.jpg';
        host.complete = false;
        host.naturalWidth = 0;
        host.setAttribute('data-sequence-intro-from', '0');
        host.setAttribute('data-sequence-intro-to', '3');
        host.setAttribute('data-sequence-intro-duration-ms', '3000');
        host.setAttribute('data-sequence-intro-easing', 'linear');
        host.setAttribute('data-sequence-intro-skip', '#' + name + 'skip');
        scope.appendChild(host);
        scope.appendChild(scriptJson(name + 'frames', {frames: [0, 1, 2, 3].map(function (index) {
            return {src: name + 'f' + index + '.jpg', width: 400, height: 800, upgrades: []};
        })}));
        const skip = new Element('button', name + 'skip');
        skip.setAttribute('type', 'button');
        skip.setAttribute('hidden', '');
        scope.appendChild(skip);
        scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
        return {scope: scope, host: host, skip: skip};
    };
    const a = makeSequence('a'),
        b = makeSequence('b');
    const stack = openStack({
        elements: {scopeA: a.scope, scopeB: b.scope},
        scrollscrub: true,
        imagesequence: true,
        window: {
            setTimeout: function (fn) {
                const timer = {fn: fn, live: true};
                timers.push(timer);
                return timer;
            },
            clearTimeout: function (timer) {
                if (timer) { timer.live = false; }
            }
        }
    });
    stack.driver.tick(16);
    assert.strictEqual(timers.length, 2,
        'two waiting scenes armed one bound each — got ' + timers.length);
    // Fire the first scene's bound: only that scene's wait ends.
    timers[0].fn();
    stack.driver.tick(32);
    // Both sets then land — the abandoned scene must keep its baseline
    // while the still-waiting one may now start its intro.
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(48);
    stack.images.forEach(function (image) { image.succeed(400, 800); });
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(a.skip.hasAttribute('hidden'), true,
        'the first scene ran an intro its expired deadline forbade');
    assert.strictEqual(b.skip.hasAttribute('hidden'), false,
        'the second scene lost the intro its live deadline still allowed');
    // The second scene's wake was disarmed when its set funded — the
    // surviving timer fires inert rather than ending a live intro.
    timers[1].fn();
    stack.driver.tick(80);
    assert.strictEqual(b.skip.hasAttribute('hidden'), false,
        'a stale wake ended the second scene\'s legitimately started intro');
}

test(siblingIntroDeadlinesActOnTheirOwnScenes);

// The cascade, not the attribute, decides what displays: an authored
// !important stylesheet rule shadows an inline background, so the
// inline frame was never the presented baseline. Adoption must read
// the computed value — treating the shadowed inline as displayed
// fetches and refines a frame nobody sees.
test('an !important-shadowed inline baseline is never adopted', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const host = new Element('i', 'host');
    host.style.setProperty('background-image', 'url("f0.jpg")');
    host.computedStyle = {'background-image': 'url("poster.png") !important'};
    const {stack} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 800, height: 450,
                upgrades: [{src: 'f0-1600.jpg', width: 1600, height: 900}]},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]},
        hostRect: {top: 0, bottom: 700, left: 0, right: 1200, width: 1200, height: 700},
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    assert.strictEqual(
        stack.images.filter(function (image) { return image.src.indexOf('f0') >= 0; }).length,
        0,
        'a shadowed inline frame was treated as displayed and refined');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("f0.jpg")',
        'the module wrote over a display it never owned');
});

// A data: URL keeps its quotes through URL normalization — the
// painted declaration must serialize them as CSS escapes or the
// property parses as nothing at all.
test('a quoted catalog URL paints as a valid escaped declaration', async function () {
    FakeSubscription.reset();
    const quoted = 'data:image/svg+xml,<svg a="b"></svg>';
    const host = new Element('div', 'host');
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        catalogDocument: {frames: [
            {src: quoted, width: 800, height: 450, upgrades: []},
            {src: 'f1.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f2.jpg', width: 800, height: 450, upgrades: []},
            {src: 'f3.jpg', width: 800, height: 450, upgrades: []}
        ]}
    });
    stack.driver.tick(16);
    const prepared = stack.images.filter(function (image) { return image.src === quoted; })[0];
    assert.ok(prepared, 'the quoted frame was never prepared');
    prepared.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("data:image/svg+xml,<svg a=\\"b\\"></svg>")',
        'the painted declaration left the embedded quote unescaped');
});

// window.Image is a platform facility: a replaced constructor
// that throws settles only the requesting preparation — the pass
// continues and every other sequence's work is untouched.
test('a throwing Image constructor fails only its own preparation', async function () {
    FakeSubscription.reset();
    const localReg = imageRegistry();
    let calls = 0;
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const bad = new Element('img', 'bad');
    bad.setAttribute('data-paste-imagesequence', '#frames');
    bad.src = 'f0.jpg';
    scope.appendChild(bad);
    const good = new Element('img', 'good');
    good.setAttribute('data-paste-imagesequence', '#frames');
    good.src = 'f0.jpg';
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames', catalog(4)));
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true,
        window: {Image: function () {
            // The module's own decode probe constructs once at define —
            // the poison lands on the first genuine preparation.
            calls += 1;
            if (calls === 2) {
                throw new Error('Image constructor poisoned');
            }
            return localReg.Image();
        }}
    });
    stack.driver.tick(16);
    assert.ok(localReg.images.length >= 3,
        'one poisoned construction aborted the whole preparation pass');
    const proof = localReg.images[0];
    proof.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(presented(good), url('f0.jpg'), 'the healthy sequence lost its baseline');
    assert.strictEqual(presented(bad), url('f0.jpg'), 'the poisoned sequence lost its baseline');
});

// A live query whose only listener surface throws cannot be observed:
// the module must not claim animated behavior it can never retire —
// every bound sequence keeps its authored static baseline.
test('a throwing query listener stands every sequence down', async function () {
    FakeSubscription.reset();
    const poisoned = {
        matches: false,
        addEventListener: function () { throw new Error('mql listener poisoned'); }
    };
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return poisoned; }}
    });
    stack.driver.tick(16);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline did not stand');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length, 0,
        'an unobservable motion preference still ran animated work');
});

// A failing modern method falls back to the legacy listener before the
// query is judged unobservable — the sequence enhances, and a change
// reported through the legacy channel still restores the baseline.
test('a throwing modern listener falls back to the legacy one', async function () {
    FakeSubscription.reset();
    const legacy = {matches: false, listeners: []};
    const query = {
        get matches() { return legacy.matches; },
        addEventListener: function () { throw new Error('modern listener poisoned'); },
        addListener: function (listener) { legacy.listeners.push(listener); },
        removeListener: function () {}
    };
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return query; }}
    });
    stack.driver.tick(16);
    await settlePromises();
    assert.ok(stack.resizeObservers.length >= 1,
        'the legacy listener fallback never bound the enhancement');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    assert.ok(stack.images.length > 0,
        'frame work did not proceed through the legacy registration');
    legacy.matches = true;
    legacy.listeners.slice().forEach(function (listener) {
        listener({matches: true});
    });
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'),
        'a legacy-reported change never restored the baseline');
});

// A non-callable listener property is an absent listener — treated like
// the inert query: its answer cannot change, so enhancement proceeds on
// the static answer rather than throwing through a truthy non-function.
test('a non-callable listener property stands every sequence down', async function () {
    FakeSubscription.reset();
    const query = {matches: false, addEventListener: true};
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return query; }}
    });
    stack.driver.tick(16);
    assert.ok(stack.resizeObservers.length >= 1,
        'a truthy non-function listener aborted the enhancement');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0,
        'frame work proceeded on a query without a listener');
    assert.strictEqual(presented(host), url('f0.jpg'),
        'the authored baseline stands behind an unobservable query');
});

// An explicitly empty index is a malformed declaration — Number('')
// silently means 0 — while every other invalid index stays inert too,
// and valid indices and sound siblings bind normally.
test('an explicitly empty sequence index stays inert', async function () {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const bad = new Element('img', 'bad');
    bad.src = 'b0.jpg';
    bad.setAttribute('data-paste-imagesequence', '#frames-bad');
    bad.setAttribute('data-sequence-from', '');
    const good = new Element('img', 'good');
    good.src = 'g0.jpg';
    good.setAttribute('data-paste-imagesequence', '#frames-good');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(bad);
    scope.appendChild(scriptJson('frames-bad', {frames: [
        {src: 'b0.jpg', width: 800, height: 450},
        {src: 'b1.jpg', width: 800, height: 450}
    ]}));
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames-good', {frames: [
        {src: 'g0.jpg', width: 800, height: 450},
        {src: 'g1.jpg', width: 800, height: 450}
    ]}));
    const stack = openStack({
        elements: {scope: scope},
        scrollscrub: true,
        imagesequence: true
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.strictEqual(presented(bad), url('b0.jpg'),
        'an empty index activated frame zero');
    assert.ok(stack.images.some(function (image) { return image.src === url('g1.jpg'); }),
        'the malformed host silenced its sound sibling');
});

test('every malformed sequence index stays inert', async function () {
    FakeSubscription.reset();
    const cases = ['  ', '-1', '1.5', '99', 'abc'];
    let count = cases.length;
    while (count--) {
        const value = cases[count];
        const {stack, host} = declaredPage({sequenceFrom: value});
        stack.driver.tick(16);
        await settleAll(stack.images);
        stack.driver.tick(48);
        assert.strictEqual(presented(host), url('f0.jpg'),
            'index "' + value + '" activated the sequence');
    }
    const valid = declaredPage({sequenceFrom: 1});
    valid.stack.driver.tick(16);
    assert.ok(valid.stack.resizeObservers.length >= 1,
        'a valid index stopped binding');
});

// A malformed observer batch skips only its bad members — the null
// entry cannot throw, and a valid entry in the same delivery still
// reaches the sequence that watches the target.
test('a malformed observer entry skips only itself', async function () {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 450, left: 0, right: 400, width: 400, height: 450},
        window: {devicePixelRatio: 1}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    const observers = stack.resizeObservers;
    assert.ok(observers.length >= 1, 'the shared observer never bound');
    assert.ok(!stack.images.some(function (image) { return image.src === url('fHD.jpg'); }),
        'sharpening was demanded before the box grew');
    observers.forEach(function (observer) {
        assert.doesNotThrow(function () {
            observer.callback([null], observer);
        }, 'a null entry escaped an observer callback');
    });
    host.rect = {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900};
    observers.forEach(function (observer) {
        observer.callback([null, {target: host}], observer);
    });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) { return image.src === url('fHD.jpg'); }),
        'the valid entry after the malformed one never delivered');
});

// A listener release that throws can strand a physical claim — never
// the operation: the op settles in spite of it, its completed frame
// paints, and the sequence keeps working afterwards.
test('a throwing listener release still settles the frame', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300); // progress 0.5 → desired f2
    stack.driver.tick(32);
    const desired = stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    })[0];
    assert.ok(desired, 'the desired frame never prepared');
    desired.removeEventListener = function () {
        throw new Error('removeEventListener poisoned');
    };
    desired.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'),
        'a throwing release stranded the settled frame');
    await settleAll(stack.images);
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1800); // progress 1 → desired f3
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f3.jpg'),
        'the sequence stopped working after the throwing release');
});

// A paint the cascade refuses is unwinnable until a fresh input, and
// the bookkeeping returns to what stood before it. Here the refused
// paint is the sharper rung the policy demands for the desired frame:
// it is fetched once, painted once, reverted, and neither painted nor
// fetched again while nothing changes; once the outranking rule is
// gone, an input paints it.
test('an unwinnable paint keeps the displayed bookkeeping', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.computedStyle = {'background-image': 'url("shadow.png") !important', 'background-size': 'cover'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null,
        resolution: true,
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 800, height: 450,
                upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 900}]};
        })},
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900}
    });
    const writes = [];
    const setProperty = host.style.setProperty.bind(host.style);
    host.style.setProperty = function (name, value, priority) {
        writes.push(value);
        setProperty(name, value, priority);
    };
    stack.driver.tick(16);
    assert.ok(stack.images.some(function (image) {
        return image.src === url('u2.jpg');
    }), 'the lookahead never prepared the demanded rung');
    await settleAll(stack.images, 1600, 900);
    scrollFraction(stack, scope, 1300); // progress 0.5 → desired frame 2
    stack.driver.tick(32); // the paint
    assert.deepStrictEqual(writes, ['url("' + url('u2.jpg') + '")'], 'the demanded rung never painted');
    let at = 32;
    for (let round = 0; round < 5; round += 1) {
        stack.driver.tick(at += 16);
        await settleAll(stack.images, 1600, 900);
    }
    assert.strictEqual(writes.length, 1, 'the refused rung was painted again without an input');
    assert.strictEqual(host.style.getPropertyValue('background-image'), '', 'the refused paint stayed inline');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('u2.jpg');
    }).length, 1, 'the refused rung was fetched again');
    assert.strictEqual(stack.driver.pending(), 0, 'the refusal kept the owner busy');
    host.computedStyle = {'background-size': 'cover'};
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('u2.jpg') + '")',
        'the reverted bookkeeping kept the refused rung as displayed');
});

// An authored !important keeps its priority through the module's
// paints — a two-argument write would demote the declaration the
// module claimed and let an ordinary stylesheet rule outrank it.
test('an authored important priority survives the frame paint', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("f0.jpg")', 'important');
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        baseline: null
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // progress 0.5 → desired f2
    stack.driver.tick(48);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('f2.jpg') + '")',
        'the desired frame never painted');
    assert.strictEqual(host.style.getPropertyPriority('background-image'),
        'important',
        'the frame paint dropped the authored priority');
});

// Frames between half and the whole decoded budget: the standing frame
// and the next desired one can never coexist (2 × 18.7 MB), and the
// standing image is never reclaimable — accounting alone would hold
// the paint on frame zero forever. The mandatory, ungated desire is
// the single-frame exception: it admits once, alone, and paints when
// it lands.
test('a desire too large to stand beside the standing frame still scrubs', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: null,
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 2880, height: 1620, upgrades: []};
        })}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 2880, 1620);
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f0.jpg'), 'frame zero displays');
    scrollFraction(stack, scope, 1300); // progress 0.5 → desired 3 of 6
    stack.driver.tick(48);
    const desired = function () {
        return stack.images.filter(function (image) { return image.src === url('f3.jpg'); });
    };
    assert.strictEqual(desired().length, 1, 'the desired frame never admitted — the scrub froze');
    assert.ok(!stack.images.some(function (image) {
        return image.src === url('f4.jpg') || image.src === url('f5.jpg');
    }), 'nothing speculative joins an exceptional admission');
    stack.driver.tick(64);
    assert.strictEqual(desired().length, 1, 'the exceptional desire was requested twice');
    desired()[0].succeed(2880, 1620);
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f3.jpg'), 'the desired frame paints once it lands');
});

// A demanded admission that cannot fit even after every reclaimable
// entry goes deletes nothing: evicting first and refusing after would
// leave the window empty for speculation to refill — the same URLs
// fetched again and again while the demand starves. Nothing optional
// admits behind the refusal, and the demand admits once the work in
// flight settles.
test('a refused demand reclaims nothing and starves no one', async function () {
    FakeSubscription.reset();
    const frames = Array.from({length: 20}, function (_, index) {
        const frame = {src: 'f' + index + '.jpg', width: 1000, height: 1000, upgrades: []};
        if (index === 10) {
            frame.upgrades = [{src: 'u10.jpg', width: 2600, height: 2600}];
        }
        return frame;
    });
    const {stack, scope, host} = declaredPage({
        baseline: null,
        resolution: true,
        sequenceFrom: 9, sequenceTo: 19,
        hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        catalogDocument: {frames: frames}
    });
    const requests = function (src) {
        return stack.images.filter(function (image) { return image.src === url(src); });
    };
    stack.driver.tick(16); // f9 demanded, f10..f14 speculate: six in flight
    await settleAll(stack.images, 1000, 1000);
    stack.driver.tick(32);
    assert.strictEqual(presented(host), url('f9.jpg'), 'frame nine displays');
    // f15 and f16 fill the account (8 × 4 MB); f16 stays in flight.
    requests('f15.jpg').forEach(function (image) { image.succeed(1000, 1000); });
    await settlePromises();
    stack.driver.tick(40);
    assert.strictEqual(requests('f16.jpg').length, 1, 'the window filled the account');
    // The host grows: frame ten's selection is now the 27 MB rung.
    host.rect = {top: 0, bottom: 2600, left: 0, right: 2600, width: 2600, height: 2600};
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    scrollFraction(stack, scope, 920); // progress .12 → desired 10
    stack.driver.tick(56);
    assert.strictEqual(requests('u10.jpg').length, 0,
        'the demand cannot fit beside the work in flight');
    stack.driver.tick(64);
    ['f11.jpg', 'f12.jpg', 'f13.jpg', 'f14.jpg', 'f15.jpg'].forEach(function (src) {
        assert.strictEqual(requests(src).length, 1, src + ' was evicted by a refused demand and refetched');
    });
    requests('f16.jpg').forEach(function (image) { image.succeed(1000, 1000); });
    await settlePromises();
    stack.driver.tick(72);
    assert.strictEqual(requests('u10.jpg').length, 1, 'the settle let the demand admit');
    const seen = {};
    stack.images.forEach(function (image) {
        assert.ok(!seen[image.src], image.src + ' was requested twice before the demand admitted');
        seen[image.src] = true;
    });
    requests('u10.jpg')[0].succeed(2600, 2600);
    await settlePromises();
    stack.driver.tick(88);
    assert.strictEqual(presented(host), url('u10.jpg'), 'the demanded frame paints');
});

// One URL held at two alias indices is one decoded image: evicting the
// alias that sits outside the window frees nothing while its twin is
// protected in the window — and deleting it anyway would only force a
// refetch of pixels the sequence still holds.
test('an alias protected in the window keeps its twin', async function () {
    FakeSubscription.reset();
    const frames = Array.from({length: 12}, function (_, index) {
        return {src: (index === 0 || index === 4) ? 'shared.jpg' : 'f' + index + '.jpg',
            width: 1000, height: 1000, upgrades: []};
    });
    const {stack, scope, host} = declaredPage({baseline: null, catalogDocument: {frames: frames}});
    let clock = 16;
    const settleRounds = async function () {
        for (let round = 0; round < 4; round += 1) {
            stack.driver.tick(clock += 16);
            await settleAll(stack.images, 1000, 1000);
        }
    };
    await settleRounds();
    assert.strictEqual(presented(host), url('shared.jpg'), 'frame zero displays the shared source');
    scrollFraction(stack, scope, 1090); // progress .29 → desired 3
    await settleRounds();
    assert.strictEqual(presented(host), url('f3.jpg'), 'frame three displays');
    scrollFraction(stack, scope, 0); // back to frame 0
    await settleRounds();
    assert.strictEqual(presented(host), url('shared.jpg'), 'frame zero displays again');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('shared.jpg');
    }).length, 1, 'the shared source was refetched though the sequence still held it');
});

// An authored baseline or catalog source the platform cannot parse is
// one host's problem: that host keeps its authored image (an
// unparseable baseline is simply never adopted), and the declarations
// after it still bind and paint.
test('an unparseable source never costs a later host its binding', async function () {
    const run = async function (makeBad) {
        FakeSubscription.reset();
        const scope = new Element('div', 'scope');
        scope.setAttribute('data-paste-scrollscrub', '');
        scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
        const bad = makeBad(scope);
        const good = new Element('img', 'good');
        good.src = 'g0.jpg';
        good.setAttribute('data-paste-imagesequence', '#frames-good');
        scope.appendChild(good);
        scope.appendChild(scriptJson('frames-good', {frames: [
            {src: 'g0.jpg', width: 800, height: 450},
            {src: 'g1.jpg', width: 800, height: 450}
        ]}));
        const stack = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
        stack.driver.tick(16);
        await settleAll(stack.images);
        scrollFraction(stack, scope, 1800);
        stack.driver.tick(32);
        await settleAll(stack.images);
        stack.driver.tick(48);
        assert.strictEqual(presented(good), url('g1.jpg'), 'the later host never bound');
        return {stack: stack, bad: bad};
    };
    await run(function (scope) {
        const img = new Element('img', 'bad');
        img.src = 'http://[';
        img.setAttribute('data-paste-imagesequence', '#frames-bad');
        scope.appendChild(img);
        scope.appendChild(scriptJson('frames-bad', catalog(2)));
        return img;
    });
    await run(function (scope) {
        const div = new Element('div', 'bad');
        div.style.setProperty('background-image', 'url("http://[")');
        div.setAttribute('data-paste-imagesequence', '#frames-bad');
        scope.appendChild(div);
        scope.appendChild(scriptJson('frames-bad', catalog(2)));
        return div;
    });
    const catalogCase = await run(function (scope) {
        const img = new Element('img', 'bad');
        img.src = 'b0.jpg';
        img.setAttribute('data-paste-imagesequence', '#frames-bad');
        scope.appendChild(img);
        scope.appendChild(scriptJson('frames-bad', {frames: [
            {src: 'b0.jpg', width: 800, height: 450},
            {src: 'http://[', width: 800, height: 450}
        ]}));
        return img;
    });
    assert.strictEqual(presented(catalogCase.bad), url('b0.jpg'), 'a malformed catalog host keeps its baseline');
    assert.ok(!catalogCase.stack.images.some(function (image) {
        return image.src === url('b0.jpg');
    }), 'the malformed catalog host still prepared work');
});

// An explicit scrub reference must name a real scrollscrub
// declaration: an element without the marker has no authored range,
// and scrubbing it on a default range would invent one.
test('a scrub reference without the scrollscrub marker stays inert', async function () {
    FakeSubscription.reset();
    const page = new Element('div', 'page');
    const other = new Element('div', 'other');
    other.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const host = new Element('img', 'host');
    host.src = 'f0.jpg';
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.setAttribute('data-sequence-scrub', '#other');
    other.appendChild(host);
    page.appendChild(other);
    page.appendChild(scriptJson('frames', catalog(4)));
    const stack = openStack({elements: {page: page}, scrollscrub: false, imagesequence: true});
    stack.driver.tick(16);
    await settleAll(stack.images);
    scrollTo(stack, other, 1300);
    other.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'the unmarked reference bound a scrub');
    assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline stands');
});

// A decode the platform refuses after a good load while the document is
// hidden — not fully active, a page restored from cache — is not the
// image's failure: the URL is withheld while the document stays hidden
// and gets exactly one retry once it is visible. A second refusal of the
// same URL is final, and so is a refusal while the document is visible:
// that URL is never refetched on later tab switches.
test('a refused decode is withheld until the document is visible again', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16); // f2 is requested as lookahead
    const requests = function () {
        return stack.images.filter(function (image) { return image.src === url('f2.jpg'); });
    };
    const switchTabs = function () {
        stack.document.hidden = true;
        stack.document.fireEvent('visibilitychange');
        stack.document.hidden = false;
        stack.document.fireEvent('visibilitychange');
    };
    assert.strictEqual(requests().length, 1, 'the frame was requested');
    requests()[0].decodeShouldFail = true;
    stack.document.hidden = true; // the refusal lands while hidden
    await settleAll(stack.images);
    stack.document.hidden = false;
    scrollFraction(stack, scope, 1300); // desired 2
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    stack.driver.tick(64);
    assert.strictEqual(requests().length, 1, 'a refused decode was retried at once');
    assert.strictEqual(presented(host), url('f0.jpg'), 'an undecoded frame painted');
    switchTabs();
    stack.driver.tick(80);
    assert.strictEqual(requests().length, 2, 'the visible document never retried the refused decode');
    // The retry is refused again while hidden: the one retry is spent.
    requests()[1].decodeShouldFail = true;
    stack.document.hidden = true;
    requests()[1].succeed(800, 450);
    await settlePromises();
    await settlePromises();
    stack.document.hidden = false;
    for (let round = 0; round < 3; round += 1) {
        switchTabs();
        stack.driver.tick(96 + round * 16);
        await settlePromises();
    }
    assert.strictEqual(requests().length, 2, 'a second refusal was retried again');
    assert.strictEqual(presented(host), url('f0.jpg'), 'an undecodable frame painted');
});

// A decode refused while the document is visible is the URL's own
// failure: no visibility return ever refetches it.
test('a decode refused while visible is never retried', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    const requests = function () {
        return stack.images.filter(function (image) { return image.src === url('f2.jpg'); });
    };
    requests()[0].decodeShouldFail = true;
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    for (let round = 0; round < 3; round += 1) {
        stack.document.hidden = true;
        stack.document.fireEvent('visibilitychange');
        stack.document.hidden = false;
        stack.document.fireEvent('visibilitychange');
        stack.driver.tick(48 + round * 16);
        await settlePromises();
    }
    assert.strictEqual(requests().length, 1, 'a visible decode refusal was refetched on a tab switch');
    assert.strictEqual(presented(host), url('f0.jpg'));
});

// A load error is the resource's own failure: it is never retried,
// visible document or not.
test('a load error stays failed across a visibility return', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0].fail();
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).length, 1, 'a failed load was retried');
    assert.strictEqual(presented(host), url('f0.jpg'));
});

// The device pixel ratio moving — a window dragged to another monitor,
// browser zoom — is an input of its own: the query on the current
// ratio stops matching, the module re-arms on the new ratio, and the
// displayed frame re-reads its need without any resize or scroll.
test('a pixel-ratio change re-reads the resolution need', async function () {
    FakeSubscription.reset();
    const queries = [];
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 450, width: 800, height: 450, left: 0, right: 800},
        window: {
            devicePixelRatio: 1,
            matchMedia: function (text) {
                const query = {
                    text: text,
                    matches: text.indexOf('resolution') !== -1,
                    listeners: [],
                    addEventListener: function (name, listener) { query.listeners.push(listener); },
                    removeEventListener: function (name, listener) {
                        query.listeners = query.listeners.filter(function (l) { return l !== listener; });
                    }
                };
                queries.push(query);
                return query;
            }
        }
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.ok(!stack.images.some(function (image) { return image.src === url('fHD.jpg'); }),
        'no upgrade is needed at ratio 1');
    const ratioQuery = queries.filter(function (query) {
        return query.text === '(resolution: 1dppx)' && query.listeners.length;
    })[0];
    assert.ok(ratioQuery, 'the module watches the current pixel ratio');
    stack.window.devicePixelRatio = 2;
    ratioQuery.matches = false;
    ratioQuery.listeners.slice().forEach(function (listener) { listener({matches: false}); });
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) { return image.src === url('fHD.jpg'); }),
        'the moved ratio never re-read the need');
    assert.ok(queries.some(function (query) {
        return query.text === '(resolution: 2dppx)' && query.listeners.length === 1;
    }), 'the watch re-armed on the new ratio');
    assert.strictEqual(ratioQuery.listeners.length, 0, 'the stale query kept its listener');
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('fHD.jpg'), 'the sharper frame commits');
});

// A reported motion change is applied by the pass, after its read
// phase — the change listener itself writes nothing. Reduced motion
// arriving withdraws a waiting intro: it never starts, its skip is
// never shown, and its buffer is not requested again.
test('a motion change is applied by the next pass, never by its listener', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, host, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, bufferMs: 1000, easing: 'linear', skip: '#skip'},
        skipId: 'skip',
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16); // the intro waits on its buffer {0, 1}
    const proofs = function () {
        return stack.images.filter(function (image) { return image.src === url('f1.jpg'); });
    };
    assert.strictEqual(proofs().length, 1, 'the waiting intro asked for its buffer');
    const order = [];
    const realSet = host.setAttribute.bind(host);
    Object.defineProperty(host, 'src', {
        configurable: true,
        get: function () { return 'f0.jpg'; },
        set: function () { order.push('write:src'); }
    });
    host.setAttribute = function (name, value) {
        order.push('write:' + name);
        return realSet(name, value);
    };
    motion.set(true);
    assert.deepStrictEqual(order, [], 'the change listener wrote to the host');
    assert.strictEqual(stack.driver.pending(), 1, 'the change scheduled a pass');
    stack.driver.tick(32);
    await settleAll(stack.images);
    for (let at = 48; at < 400; at += 16) {
        stack.driver.tick(at);
        await settleAll(stack.images);
    }
    assert.strictEqual(skip.hasAttribute('hidden'), true, 'the withdrawn intro revealed its skip');
    assert.strictEqual(proofs().length, 1, 'the withdrawn intro kept re-requesting its buffer');
    assert.deepStrictEqual(order, [], 'nothing was painted, so nothing was restored');
});

// The pass itself applies the transition: a frame painted before the
// change comes off at the next pass, not before it.
test('a motion change restores the baseline at the next pass', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'a frame painted');
    motion.set(true);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the listener restored the baseline itself');
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the pass never applied the reported change');
});

// A preference that turns reduced without reporting the change (a
// wrapped matchMedia whose listener never fires) is still honoured: the
// next pass any input schedules reads the live answer.
test('a motion change the platform never reports is honoured at the next pass', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f2.jpg'), 'a frame painted');
    motion.matches = true;
    scrollFraction(stack, scope, 1350);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the unreported preference was not honoured');
});

// A motion preference the platform cannot report is static: no
// matchMedia at all, or one that throws, keeps every host on its
// authored baseline — the same answer an unobservable query gets.
test('an unobservable motion preference keeps the static baseline', async function () {
    const run = async function (matchMedia) {
        FakeSubscription.reset();
        const {stack, scope, host} = declaredPage({window: {matchMedia: matchMedia}});
        stack.driver.tick(16);
        scrollFraction(stack, scope, 1300);
        stack.driver.tick(32);
        await settleAll(stack.images);
        stack.driver.tick(48);
        assert.strictEqual(stack.images.length, 0, 'animated frame work ran on an unobservable preference');
        assert.strictEqual(presented(host), url('f0.jpg'), 'the authored baseline did not stand');
    };
    await run(null);
    await run(function () { throw new Error('matchMedia poisoned'); });
});

// Numbers are plain decimal digits: hexadecimal, binary, exponent and
// signed spellings are malformed declarations, and an explicitly empty
// intro duration is malformed like an empty buffer or index — never a
// silent "no intro".
test('only plain decimal numbers declare a sequence', async function () {
    const run = async function (name, value) {
        FakeSubscription.reset();
        const {stack, scope, host} = declaredPage({});
        host.setAttribute(name, value);
        // Re-open the stack so the define-time sweep reads the attribute.
        const reopened = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
        reopened.driver.tick(16);
        await settleAll(reopened.images);
        scrollFraction(reopened, scope, 1300);
        reopened.driver.tick(32);
        await settleAll(reopened.images);
        reopened.driver.tick(48);
        assert.strictEqual(reopened.images.length, 0, name + '="' + value + '" bound a sequence');
        assert.strictEqual(presented(host), url('f0.jpg'));
        return stack;
    };
    await run('data-sequence-to', '0x2');
    await run('data-sequence-from', '0b1');
    await run('data-sequence-to', '1e0');
    await run('data-sequence-from', '-0');
    await run('data-sequence-scrub-buffer-frames', '0x1');
    await run('data-sequence-intro-buffer-ms', '1e3');
    await run('data-sequence-intro-duration-ms', '');
    await run('data-sequence-intro-duration-ms', '0x10');
});

// The preparation fetch carries only what an img host authored for its
// own request: a background host's crossorigin or referrerpolicy
// attribute governs nothing it paints, so nothing rides along.
test('a background host adds no request attributes to its preparation', function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.setAttribute('crossorigin', 'use-credentials');
    host.setAttribute('referrerpolicy', 'no-referrer');
    const {stack} = declaredPage({host: host, baseline: null, imageProperty: 'background-image'});
    stack.driver.tick(16);
    assert.ok(stack.images.length > 0, 'preparation started');
    stack.images.forEach(function (image) {
        assert.strictEqual(image.crossOrigin, null, 'crossorigin copied from a background host');
        assert.strictEqual(image.referrerPolicy, '', 'referrerpolicy copied from a background host');
    });
});

// An Image substitute that is not an element cannot carry the load and
// error subscriptions — core would bind them to the document and the
// operation would never settle. The preparation fails at once instead:
// no request hangs, and the baseline stands.
test('a non-element Image substitute fails its preparation', async function () {
    FakeSubscription.reset();
    const registry = imageRegistry();
    let constructed = 0;
    const {stack, scope, host} = declaredPage({
        baseline: null,
        window: {Image: function () {
            const image = registry.Image();
            delete image.nodeType;
            constructed += 1;
            return image;
        }}
    });
    stack.driver.tick(16);
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(constructed > 1, 'no preparation was attempted');
    assert.strictEqual(registry.images.length, 0, 'a non-element substitute started a request');
    assert.ok(!FakeSubscription.registry.some(function (subscription) {
        return subscription.name === 'load' && subscription.target === stack.document;
    }), 'a preparation subscribed to the document');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    await settlePromises();
    assert.strictEqual(presented(host), url('poster.jpg'), 'a failed preparation painted');
});

// A background commit is a pure write: whether the cascade displays
// the declaration is read in the next pass's read phase, never by a
// computed-style read after the write.
test('a background commit reads no style after its write', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        host: new Element('div', 'host'),
        baseline: null,
        imageProperty: 'background-image'
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    const order = [];
    // The module captured getComputedStyle at define; the fixture's
    // computed style reads the host's planted map, so a getter on that
    // map records every computed-style read of the host.
    const plantedStyle = host.computedStyle || {};
    Object.defineProperty(host, 'computedStyle', {
        configurable: true,
        get: function () {
            order.push('read:style');
            return plantedStyle;
        }
    });
    const realSet = host.style.setProperty.bind(host.style);
    host.style.setProperty = function (name, value, priority) {
        order.push('write:style');
        return realSet(name, value, priority);
    };
    stack.driver.tick(64);
    const firstWrite = order.indexOf('write:style');
    assert.ok(firstWrite >= 0, 'the pass painted');
    assert.ok(order.indexOf('read:style') >= 0, 'the style spy saw no read at all');
    assert.strictEqual(order.lastIndexOf('read:style') < firstWrite, true,
        'a style read followed the paint: ' + order.join(' → '));
    order.length = 0;
    stack.driver.tick(80); // the verification pass reads, then holds
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")');
});

// decode() settles on its own later turn: a load whose decode is still
// pending keeps its physical slot and paints nothing; the paint lands
// only with the decode.
test('a pending decode holds its slot and paints only when it settles', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({});
    stack.driver.tick(16);
    const f2 = stack.images.filter(function (image) { return image.src === url('f2.jpg'); })[0];
    f2.deferDecode = true;
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('f0.jpg'), 'a load without its decode painted');
    scrollFraction(stack, scope, 1310); // still desired 2 — a fresh pass
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('f2.jpg');
    }).length, 1, 'the decoding request lost its slot and was duplicated');
    f2.resolveDecode();
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the settled decode paints');
});

// An intrinsically sized img — no authored width and height — lays out
// from its source's pixels, so a sharper representation is written as a
// srcset width descriptor with a module-owned sizes equal to the frame
// base's intrinsic width: the box keeps the base frame's size and the
// next pass does not climb the ladder because the box grew. A later
// base paint withdraws the pair first, and reduced motion withdraws it
// too, leaving the authored src.
test('an unsized img sharpens through srcset and sizes, never src', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const authored = new Element('img', 'host');
    authored.src = 'f0.jpg';
    const {stack, scope, host} = declaredPage({
        host: authored,
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900},
        window: {matchMedia: function () { return motion; }}
    });
    const srcWrites = [];
    let src = host.src;
    Object.defineProperty(host, 'src', {
        configurable: true,
        get: function () { return src; },
        set: function (value) { srcWrites.push(value); src = value; }
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(32);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(48);
    assert.strictEqual(presented(host), url('fHD.jpg'), 'the sharper rung presents');
    assert.strictEqual(host.getAttribute('srcset'), url('fHD.jpg') + ' 1600w', 'one width descriptor');
    assert.strictEqual(host.getAttribute('sizes'), '800px', 'sizes is the base frame\'s intrinsic width');
    assert.deepStrictEqual(srcWrites, [], 'an upgrade was written as a plain src');
    // The cap falls below the sharper rung: the next frame paints its
    // base as src, and the module's pair comes off first.
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(64);
    await settleAll(stack.images, 800, 450);
    stack.driver.tick(80);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the base frame paints as src');
    assert.strictEqual(host.hasAttribute('srcset'), false, 'the module srcset stayed behind a base paint');
    assert.strictEqual(host.hasAttribute('sizes'), false, 'the module sizes stayed behind a base paint');
    // Sharpen again, then stand down under reduced motion.
    host.computedStyle = {};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(96);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(112);
    assert.strictEqual(presented(host), url('fHD.jpg'), 'the standing frame sharpened again');
    motion.set(true);
    stack.driver.tick(128);
    assert.strictEqual(host.hasAttribute('srcset'), false, 'the stand-down left the module srcset');
    assert.strictEqual(host.hasAttribute('sizes'), false, 'the stand-down left the module sizes');
    assert.strictEqual(host.getAttribute('src'), 'f0.jpg', 'the authored src attribute returns verbatim');
});

// An img sequence host with no authored src has no baseline to stand
// on or return to: it is malformed, stays exactly as authored, and is
// reported once — siblings keep working.
test('an img host without an authored src is rejected and reported', async function () {
    FakeSubscription.reset();
    const {stack, scope, host, reports} = declaredPage({noSrc: true});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'a src-less host requested frames');
    assert.strictEqual(host.getAttribute('src'), null, 'a src-less host was painted');
    assert.strictEqual(host.hasAttribute('srcset'), false, 'a src-less host was painted');
    const kept = await reportsAfterATurn(reports);
    assert.strictEqual(kept.length, 1, 'the src-less host is reported once');
    assert.ok(/authored src/.test(kept[0].message), 'the report says what is missing');
});

// The Image constructor is captured once at define: a page script that
// replaces it later reaches no preparation. A constructor that refuses
// is no verdict on the URL — the slot frees and the next input asks
// again, so the URL is requested once the constructor works.
test('Image is captured at define, and a refused construction is not a source failure', async function () {
    FakeSubscription.reset();
    const registry = imageRegistry();
    let refuse = 1;
    const {stack, scope, host} = declaredPage({
        baseline: null,
        window: {Image: function () {
            if (refuse > 0) {
                refuse -= 1;
                throw new Error('constructor wrapped');
            }
            return registry.Image();
        }}
    });
    // The define-time decode probe spent the one refusal; refuse the
    // first preparation too.
    refuse = 1;
    stack.window.Image = function () { throw new Error('replaced after define'); };
    stack.driver.tick(16);
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(!registry.images.some(function (image) { return image.src === url('f0.jpg'); }),
        'the refused construction still reached the URL');
    assert.ok(registry.images.length > 0, 'the constructor captured at define was not used');
    scrollFraction(stack, scope, 10); // a fresh input asks again
    stack.driver.tick(48);
    assert.ok(registry.images.some(function (image) { return image.src === url('f0.jpg'); }),
        'a refused construction was remembered as the URL\'s failure');
    await settleAll(registry.images);
    stack.driver.tick(64);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the frame paints once the constructor works');
});

// A background claim is reverted only on positive evidence. Computed
// style the module cannot read is no evidence: the claim stands and the
// bookkeeping keeps following the paint.
test('unreadable computed style keeps a background claim', async function () {
    FakeSubscription.reset();
    let readable = true;
    const host = new Element('div', 'host');
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        window: {
            // Readable for the bind-time adoption only; afterwards a
            // legacy or hostile surface without getPropertyValue.
            getComputedStyle: function () {
                if (!readable) {
                    return {};
                }
                return {
                    getPropertyValue: function (name) {
                        return name === 'background-image' ? 'url("' + url('f0.jpg') + '")' : '';
                    }
                };
            }
        }
    });
    readable = false;
    stack.driver.tick(16);
    await settleAll(stack.images);
    let at = 32;
    for (const offset of [1300, 1800, 0]) {
        scrollFraction(stack, scope, offset);
        stack.driver.tick(at += 16);
        await settleAll(stack.images);
        stack.driver.tick(at += 16);
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f0.jpg') + '")',
        'without evidence of refusal, the scrub back to the start painted the start frame');
});

// Positive evidence of refusal reverts both halves: the bookkeeping and
// the inline declaration the claim wrote — no stale frame stays in the
// inline layer for a later cascade change to reveal.
test('a refused background claim restores the inline layer too', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("poster.jpg")');
    // A stylesheet !important rule outranks the inline layer.
    host.computedStyle = {'background-image': 'url("' + url('sheet.jpg') + '") !important'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image'
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint
    stack.driver.tick(64); // the verification
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("poster.jpg")',
        'the refused claim left its frame in the inline layer');
});

// The verification of a background claim reads the computed source
// alone: no range re-measure, no host or scope geometry.
test('a background claim is verified without re-measuring the scene', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image'
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")');
    const reads = [];
    [host, scope].forEach(function (element) {
        const rect = element.getBoundingClientRect.bind(element);
        element.getBoundingClientRect = function () {
            reads.push(element.id);
            return rect();
        };
    });
    stack.driver.tick(64); // the verification pass
    assert.deepStrictEqual(reads, [], 'the verification re-measured geometry');
    assert.strictEqual(stack.driver.pending(), 0, 'the verified claim left the owner busy');
});

// Focus that does not land is not assumed: a scope the platform will
// not focus returns the borrowed tabindex at once, and the retiring
// control is blurred rather than left focused while it hides.
test('a skip retire verifies that focus moved', async function () {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    scope.focus = function () {};
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    assert.strictEqual(skip.getAttribute('hidden'), '', 'the skip retires');
    assert.notStrictEqual(stack.document.activeElement, skip, 'focus stayed on the hidden control');
    assert.strictEqual(scope.hasAttribute('tabindex'), false, 'the borrowed tabindex was left behind');
});

// The blur lease returns only the module's own '-1': a tabindex the
// page wrote while the scope held focus is the page's.
test('the blur lease leaves a tabindex the page set', async function () {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    assert.strictEqual(stack.document.activeElement, scope, 'focus moved to the scope');
    scope.setAttribute('tabindex', '0');
    scope.blur();
    scope.fireEvent('blur');
    assert.strictEqual(scope.getAttribute('tabindex'), '0', 'the page\'s tabindex was removed');
});

// Page or platform code throwing inside one host's pass costs only that host:
// its sibling keeps scrubbing, the failure is contained without a
// report, and the throwing host does not spin the frame loop.
test('a host that throws in the pass never starves its siblings', async function () {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const make = function (id) {
        const host = new Element('div', id);
        host.setAttribute('data-paste-imagesequence', '#frames');
        host.rect = {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450};
        scope.appendChild(host);
        return host;
    };
    const first = make('first');
    const second = make('second');
    scope.appendChild(scriptJson('frames', catalog(4)));
    const stack = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
    first.style.setProperty = function () { throw new Error('hostile style surface'); };
    let at = 16;
    stack.driver.tick(at);
    for (const offset of [1300, 1800]) {
        scrollFraction(stack, scope, offset);
        for (let round = 0; round < 4; round += 1) {
            stack.driver.tick(at += 16);
            await settleAll(stack.images);
        }
    }
    stack.driver.tick(at += 16);
    assert.strictEqual(second.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'the sibling stopped scrubbing behind the throwing host');
    assert.strictEqual(stack.driver.pending(), 0, 'the throwing host keeps the frame loop spinning');
    const reports = await reportsAfterATurn(stack.reports);
    assert.strictEqual(reports.length, 0, 'a page or platform failure is contained, not reported');
});

// The viewport root's scrollable span follows the document's own boxes,
// and an element root's span follows its content: the module observes
// them, so content growing above a subject — or a nested root becoming
// scrollable — re-measures without a scroll or resize.
test('document and root content growth re-measure the range', function () {
    FakeSubscription.reset();
    const {stack} = declaredPage({});
    stack.driver.tick(16);
    const observed = stack.resizeObservers[stack.resizeObservers.length - 1].observed;
    assert.ok(observed.indexOf(stack.document.documentElement) >= 0,
        'the document element is not observed for a viewport root');
    stack.resizeObservers[stack.resizeObservers.length - 1].trigger(stack.document.documentElement);
    assert.strictEqual(stack.driver.pending(), 1, 'document growth asked for no pass');

    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    const nested = declaredPage({scroller: scroller});
    nested.stack.driver.tick(16);
    const nestedObserved = nested.stack.resizeObservers[nested.stack.resizeObservers.length - 1].observed;
    assert.ok(nestedObserved.indexOf(scroller) >= 0, 'the element root is not observed');
    assert.ok(nestedObserved.indexOf(nested.scope) >= 0, 'the element root\'s content is not observed');
});

// --paste-resolution-max-width reads through the one plain-decimal
// grammar every resolution owner shares: '1280.' caps exactly as 1280
// does; an exponent is no cap at all.
test('the resolution cap uses the shared reading', async function () {
    const run = async function (cap) {
        FakeSubscription.reset();
        const host = new Element('img', 'host');
        host.setAttribute('width', '800');
        host.setAttribute('height', '450');
        host.computedStyle = {'--paste-resolution-max-width': cap};
        const {stack} = declaredPage({
            host: host,
            resolution: true,
            upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
            hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900}
        });
        stack.driver.tick(16);
        await settleAll(stack.images);
        stack.driver.tick(32);
        return stack.images.some(function (image) { return image.src === url('fHD.jpg'); });
    };
    assert.strictEqual(await run('1280.'), false, '1280. did not cap');
    assert.strictEqual(await run('1e3'), true, 'an exponent capped');
});

// Selection is memoized per frame under the policy snapshot's version:
// a pass whose policy changed nothing asks no frame's need again, and
// a pass after a policy change computes each frame's need once however
// many questions it asks.
test('a pass computes each frame\'s selection once', async function () {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        resolution: true,
        scrubBuffer: 3,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}]
    });
    const resolution = stack.modules.imageresolution;
    const needFor = resolution.needFor;
    let calls = 0;
    resolution.needFor = function () {
        calls += 1;
        return needFor.apply(null, arguments);
    };
    stack.driver.tick(16);
    await settleAll(stack.images);
    calls = 0;
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    assert.strictEqual(calls, 0, 'an unchanged policy recomputed a need it already had');
    stack.elements.scope.children[0].rect = {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.ok(calls > 0, 'the pass selected nothing');
    assert.ok(calls <= 4, 'one pass computed the same frame\'s need repeatedly: ' + calls);
});

// The single-frame exception prices the candidate beside the standing
// image only when they are different resources: the standing frame's
// own proof, alone within the budget, is never admitted as an exception
// just because other work the module still owns holds the room.
test('the standing frame\'s own proof is priced once, not as a pair', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const host = new Element('div', 'host');
    // The stylesheet first shows a small frame; a media change later
    // makes the authored baseline the large frame zero.
    host.computedStyle = {'background-image': 'url("' + url('f3.jpg') + '")'};
    const {stack, scope} = declaredPage({
        host: host,
        imageProperty: 'background-image',
        resolution: true,
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
        window: {matchMedia: function () { return motion; }},
        catalogDocument: {frames: [
            {src: 'f0.jpg', width: 2200, height: 2300, upgrades: []},
            {src: 'f1.jpg', width: 1900, height: 1900, upgrades: []},
            {src: 'f2.jpg', width: 1900, height: 1900, upgrades: []},
            {src: 'f3.jpg', width: 100, height: 100, upgrades: []}
        ]}
    });
    scrollFraction(stack, scope, 1100); // progress .3 → desired 1
    stack.driver.tick(16);
    assert.ok(stack.images.some(function (image) { return image.src === url('f1.jpg'); }) &&
        stack.images.some(function (image) { return image.src === url('f2.jpg'); }),
        'the two large frames are in flight');
    host.computedStyle = {'background-image': 'url("' + url('f0.jpg') + '")'};
    motion.set(true);
    stack.driver.tick(32); // the stand-down
    stack.driver.tick(48); // adoption, then the static pass
    stack.driver.tick(64);
    assert.ok(!stack.images.some(function (image) { return image.src === url('f0.jpg'); }),
        'the standing proof was admitted as an oversized pair');
});

// A background-image transition computes a cross-fade between the old
// and the claimed source while it runs. That value names the claim
// without being it: the claim stays pending, is read again each pass,
// and owns the paint once the transition lands — never reverted, never
// marked unwinnable, and the sequence keeps advancing.
test('a background transition keeps the claim pending until it lands', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    let fading = 0;
    let prior = '';
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image' && inline && fading > 0) {
                            fading -= 1;
                            return 'cross-fade(' + (prior || 'none') + ' 40%, ' + inline + ')';
                        }
                        return inline || '';
                    }
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    fading = 3;
    stack.driver.tick(48); // the paint
    const claimed = 'url("' + url('f2.jpg') + '")';
    assert.strictEqual(host.style.getPropertyValue('background-image'), claimed);
    let at = 48;
    for (let round = 0; round < 5; round += 1) {
        stack.driver.tick(at += 16);
        assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
            'a transition in flight reverted the claim');
    }
    assert.strictEqual(fading, 0, 'the pending claim was not read again each pass');
    assert.strictEqual(stack.driver.pending(), 0, 'the landed claim left the owner busy');
    prior = claimed;
    fading = 3;
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    for (let round = 0; round < 5; round += 1) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'the sequence stopped advancing behind a transition');
});

// A computed cross-fade the page never resolves is verified by its own
// passes for five seconds of frame time from the first pending read and
// no longer: the frames stop, the claim is never reverted, and the next
// input-driven pass treats the still-pending value as the sequence's
// own, so the sequence keeps advancing.
test('a permanent cross-fade stops verifying after the bound and keeps the claim', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    let fading = false;
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image' && inline && fading) {
                            return 'cross-fade(none 40%, ' + inline + ')';
                        }
                        return inline || '';
                    }
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    fading = true;
    stack.driver.tick(48); // the paint
    const claimed = 'url("' + url('f2.jpg') + '")';
    assert.strictEqual(host.style.getPropertyValue('background-image'), claimed);
    stack.driver.tick(64); // the first pending read
    let at = 64;
    while (at < 64 + 4990) {
        assert.strictEqual(stack.driver.pending(), 1, 'a pending claim stopped verifying inside the bound');
        stack.driver.tick(at += 16);
    }
    while (at < 64 + 5100 && stack.driver.pending() > 0) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 0, 'a permanent cross-fade kept requesting frames');
    assert.ok(at <= 64 + 5016, 'the verification outlived its bound');
    assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
        'a pending claim was reverted');
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
        'the input-driven pass reverted a still-pending claim');
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
        'a still-pending claim was reverted after the input-driven pass');
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'the sequence stopped advancing behind a permanent cross-fade');
});

// Under a background-image transition the first computed reads after a
// paint can still be the source the paint replaced, before the
// transition reports the change. A host that lags that way is modelled
// here: the read reports the previous value `lag` more times after
// each write.
function laggingPage(transition) {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const state = {lag: 0, shown: ''};
    const page = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image') {
                            if (inline !== state.shown && state.lag > 0) {
                                state.lag -= 1;
                                return state.shown;
                            }
                            state.shown = inline;
                            return inline || '';
                        }
                        return transition[name] || '';
                    }
                };
            }
        }
    });
    return Object.assign({state: state}, page);
}

async function paintThenAdvance(page, lag) {
    const {stack, scope, host, state} = page;
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the first paint
    stack.driver.tick(64); // its verification
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'precondition: the first paint stands');
    state.lag = lag;
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(80);
    await settleAll(stack.images);
    stack.driver.tick(96); // the second paint, by now
    return 96;
}

test('a transitioned predecessor read keeps the claim pending until it lands', async function () {
    const runs = [
        {'transition-property': 'all', 'transition-duration': '0.3s', 'transition-delay': '0s'},
        {'transition-property': 'opacity, background', 'transition-duration': '0s, 300ms',
            'transition-delay': '0s'},
        {'transition-property': 'background-image', 'transition-duration': '0s', 'transition-delay': '0.1s'}
    ];
    for (const transition of runs) {
        const page = laggingPage(transition);
        let at = await paintThenAdvance(page, 3);
        assert.ok(page.state.lag < 3, 'precondition: the second paint was read');
        assert.strictEqual(page.stack.driver.pending(), 1, 'the predecessor read was not verified again');
        for (let round = 0; round < 4; round += 1) {
            page.stack.driver.tick(at += 16);
        }
        assert.strictEqual(page.state.lag, 0, 'the claim was not read until it landed');
        assert.strictEqual(page.host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
            'a transition in flight reverted the claim: ' + JSON.stringify(transition));
        assert.strictEqual(page.stack.driver.pending(), 0, 'the landed claim left the owner busy');
    }
});

test('a predecessor read without a background-image transition reverts the claim', async function () {
    const runs = [
        {},
        {'transition-property': 'opacity', 'transition-duration': '0.3s', 'transition-delay': '0s'},
        {'transition-property': 'all', 'transition-duration': '0s', 'transition-delay': '0s'},
        {'transition-property': 'all', 'transition-duration': '0.2s', 'transition-delay': '-0.2s'},
        {'transition-property': 'background-image, all', 'transition-duration': '0.3s, 0s',
            'transition-delay': '0s'}
    ];
    for (const transition of runs) {
        const page = laggingPage(transition);
        let at = await paintThenAdvance(page, 1);
        page.stack.driver.tick(at += 16);
        assert.strictEqual(page.state.lag, 0, 'precondition: the second paint was read');
        assert.strictEqual(page.host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
            'a predecessor without a transition kept the claim: ' + JSON.stringify(transition));
    }
});

test('a transitioned predecessor that never gives way reverts at the bound', async function () {
    const page = laggingPage({'transition-property': 'all', 'transition-duration': '0.3s',
        'transition-delay': '0s'});
    let at = await paintThenAdvance(page, 1e9);
    page.stack.driver.tick(at += 16); // the first pending read
    const first = at;
    while (at < first + 4990) {
        assert.strictEqual(page.stack.driver.pending(), 1, 'a predecessor claim stopped verifying inside the bound');
        assert.strictEqual(page.host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
            'a predecessor claim reverted inside the bound');
        page.stack.driver.tick(at += 16);
    }
    while (at < first + 5100 && page.host.style.getPropertyValue('background-image') ===
            'url("' + url('f3.jpg') + '")') {
        page.stack.driver.tick(at += 16);
    }
    assert.ok(at <= first + 5016, 'the predecessor outlived its bound');
    assert.strictEqual(page.host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'a predecessor past the bound kept the claim');
});

// Where the host lists its animations, a background-image transition
// still in flight — delayed or running — keeps a claim pending whatever
// older source the computed value still names: a chain of paints faster
// than the transition is never mistaken for another writer. With the
// capability present and nothing in flight, that value is foreign. A
// CSS transition always names the longhand it animates, so only
// 'background-image' and an unrelated longhand are listed here.
test('a listed background-image transition keeps a claim the computed value lags behind', async function () {
    const claimed = 'url("' + url('f3.jpg') + '")';
    for (const listed of ['background-image', 'opacity', false]) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        const state = {stale: false, running: false};
        host.getAnimations = function () {
            return state.running ? [{transitionProperty: state.running}] : [];
        };
        const {stack, scope} = declaredPage({
            host: host,
            baseline: null,
            imageProperty: 'background-image',
            window: {
                getComputedStyle: function (element) {
                    return {
                        getPropertyValue: function (name) {
                            const inline = element.style ? element.style.getPropertyValue(name) : '';
                            if (name === 'background-image') {
                                return state.stale ? 'url("' + url('older.jpg') + '")' : inline || '';
                            }
                            return '';
                        }
                    };
                }
            }
        });
        stack.driver.tick(16);
        scrollFraction(stack, scope, 1300);
        stack.driver.tick(32);
        await settleAll(stack.images);
        stack.driver.tick(48); // the first paint
        stack.driver.tick(64); // its verification
        assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
            'precondition: the first paint stands');
        state.stale = true;
        state.running = listed;
        scrollFraction(stack, scope, 1800);
        stack.driver.tick(80);
        await settleAll(stack.images);
        let at = 96;
        stack.driver.tick(at); // the second paint, by now
        for (let round = 0; round < 4; round += 1) {
            stack.driver.tick(at += 16);
        }
        if (!listed || listed === 'opacity') {
            assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
                'a foreign value with no transition in flight kept the claim');
            continue;
        }
        assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
            'a listed transition in flight reverted the claim');
        assert.strictEqual(stack.driver.pending(), 1, 'the claim was not verified again');
        state.stale = false;
        state.running = false;
        stack.driver.tick(at += 16);
        stack.driver.tick(at += 16);
        assert.strictEqual(host.style.getPropertyValue('background-image'), claimed,
            'the landed claim was reverted');
        assert.strictEqual(stack.driver.pending(), 0, 'the landed claim left the owner busy');
    }
});

// Where the host lists its animations, that list alone answers for
// transitions: a declared background-image transition with nothing in
// flight — a foreign !important rule keeps the computed value from ever
// changing, so none starts — reverts on its first read instead of
// polling the predecessor for the whole pending bound.
test('a listed-animation host reverts a predecessor read at once whatever transition is declared', async function () {
    const page = laggingPage({'transition-property': 'all', 'transition-duration': '0.3s',
        'transition-delay': '0s'});
    page.host.getAnimations = function () {
        return [];
    };
    let at = await paintThenAdvance(page, 1e9);
    page.stack.driver.tick(at += 16);
    assert.strictEqual(page.host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'a declared transition with nothing listed kept the predecessor pending');
    assert.strictEqual(page.stack.driver.pending(), 0, 'the refused paint kept requesting frames');
});

// A vector source reports no pixel size of its own — a viewBox-only SVG
// reads 0x0 in one engine and a default box in another — so the decoded
// size check never refuses it, while a raster reporting the same size is
// still refused.
test('a vector frame source is never refused for the size its engine reports', async () => {
    const vector = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    for (const sample of [
        {src: 'f0.svg', expected: url('f0.svg')},
        {src: 'f0.SVG?v=2#top', expected: url('f0.SVG?v=2#top')},
        {src: 'f0.svgz', expected: url('f0.svgz')},
        {src: vector, expected: vector},
        {src: 'f0.png', expected: url('poster.jpg')},
        {src: 'f0.svg.png', expected: url('poster.jpg')}
    ]) {
        FakeSubscription.reset();
        const {stack, host} = declaredPage({baseline: null,
            catalogDocument: {frames: [{src: sample.src, width: 800, height: 450}]}});
        stack.driver.tick(16);
        const frame = stack.images.find(image => image.src === sample.expected ||
            (sample.expected === url('poster.jpg') && image.src === url(sample.src)));
        assert.ok(frame, 'the frame was requested: ' + sample.src);
        frame.succeed(267, 150);
        await settlePromises();
        stack.driver.tick(32);
        assert.strictEqual(presented(host), sample.expected, 'the decoded size check misjudged ' + sample.src);
    }
});

// Sharpening waits while a background claim is pending. A rung the
// grown host needs that lands meanwhile is looked at again by the pass
// after the claim settles, with no further input.
test('a sharper rung landing while a claim is pending paints once the claim settles', async () => {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const state = {fading: true};
    const frames = Array.from({length: 4}, (_, index) => ({src: 'f' + index + '.jpg', width: 800, height: 450,
        upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 900}]}));
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        resolution: true,
        catalogDocument: {frames},
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
        window: {
            devicePixelRatio: 1,
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image' && inline && state.fading) {
                            return 'cross-fade(none 40%, ' + inline + ')';
                        }
                        return name === 'background-image' ? inline || '' : '';
                    }
                };
            }
        }
    });
    let at = 16;
    stack.driver.tick(at);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'precondition: frame 2 paints');
    host.rect = {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900};
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    const upgrade = stack.images.find(image => image.src === url('u2.jpg'));
    assert.ok(upgrade, 'precondition: the grown host requests its rung');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'precondition: sharpening waits while the claim is pending');
    state.fading = false;
    for (let round = 0; round < 3; round += 1) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('u2.jpg') + '")',
        'the rung that landed while the claim was pending was not painted once it settled');
});

// Reduced motion restores the stylesheet poster; under a background-image
// transition the computed value is the transition's until it ends. The
// adoption stays owed: a listed transition's settling asks for the pass,
// and without the list the next input does. The adopted initial frame
// zero then sharpens.
test('reduced motion adopts a poster restored through a transition once it settles', async () => {
    for (const listed of [true, false]) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        const motion = mediaQueryList();
        const state = {fading: false, finish: null};
        if (listed) {
            host.getAnimations = function () {
                if (!state.fading) {
                    return [];
                }
                return [{transitionProperty: 'background-image',
                    finished: new Promise(function (resolve) { state.finish = resolve; })}];
            };
        }
        const frames = Array.from({length: 4}, (_, index) => ({src: 'f' + index + '.jpg', width: 800, height: 450,
            upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 900}]}));
        const {stack, scope} = declaredPage({
            host: host,
            baseline: null,
            imageProperty: 'background-image',
            resolution: true,
            catalogDocument: {frames},
            hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
            window: {
                devicePixelRatio: 2,
                matchMedia: function () { return motion; },
                getComputedStyle: function (element) {
                    return {
                        getPropertyValue: function (name) {
                            const inline = element.style ? element.style.getPropertyValue(name) : '';
                            if (name !== 'background-image') {
                                return '';
                            }
                            if (inline) {
                                return inline;
                            }
                            return state.fading ? 'cross-fade(url("' + url('u2.jpg') + '"), url("' + url('f0.jpg') +
                                '"), 0.5)' : 'url("' + url('f0.jpg') + '")';
                        }
                    };
                }
            }
        });
        let at = 16;
        const land = async function () {
            for (const image of stack.images) {
                if (!image.landed) {
                    image.landed = true;
                    image.succeed(image.src.includes('/u') ? 1600 : 800, image.src.includes('/u') ? 900 : 450);
                }
            }
            await settlePromises();
        };
        stack.driver.tick(at);
        scrollFraction(stack, scope, 1300);
        for (let round = 0; round < 4; round += 1) {
            stack.driver.tick(at += 16);
            await land();
        }
        assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('u2.jpg') + '")',
            'precondition: the sharp frame 2 paints');
        motion.set(true);
        stack.driver.tick(at += 16);
        assert.strictEqual(host.style.getPropertyValue('background-image'), '', 'precondition: the poster restores');
        state.fading = true;
        const before = stack.images.length;
        stack.driver.tick(at += 16);
        assert.strictEqual(stack.driver.pending(), 0, 'the adoption polled frames mid-transition');
        assert.strictEqual(stack.images.length, before, 'a cross-fade was adopted as the poster');
        state.fading = false;
        if (listed) {
            state.finish();
            await settlePromises();
        } else {
            assert.strictEqual(stack.driver.pending(), 0, 'without a listed transition nothing asks for a pass');
            stack.window.fireEvent('resize');
        }
        assert.ok(stack.driver.pending() > 0, 'the owed adoption asked for no pass');
        stack.driver.tick(at += 16);
        assert.ok(stack.images.some(image => image.src === url('u0.jpg') && !image.landed),
            'the adopted poster was not sharpened (listed transition: ' + listed + ')');
        await land();
        stack.driver.tick(at += 16);
        assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('u0.jpg') + '")',
            'the sharpened poster was not painted');
    }
});

// A paint made while an earlier claim is still pending is a fresh claim
// with a fresh bound: its verification passes run five seconds of frame
// time from its own first pending read, not from the chain's first.
test('a fresh paint inside a pending chain starts a fresh bound', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    let fading = false;
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image' && inline && fading) {
                            return 'cross-fade(none 40%, ' + inline + ')';
                        }
                        return inline || '';
                    }
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    fading = true;
    stack.driver.tick(48); // the first paint
    stack.driver.tick(64); // its first pending read
    let at = 64;
    while (at < 64 + 3000) {
        stack.driver.tick(at += 16);
    }
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'precondition: the second paint was made inside the pending chain');
    const second = at;
    while (at < 64 + 5200) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 1, 'the fresh claim inherited the chain\'s bound');
    while (at < second + 5100 && stack.driver.pending() > 0) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 0, 'the fresh claim outlived its own bound');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'a pending claim was reverted');
});

// A cross-fade that does not name the claim is foreign: the claim is
// refused like any other outranking value.
test('a computed value that never names the claim reverts it', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("poster.jpg")');
    host.computedStyle = {
        'background-image': 'cross-fade(url("' + url('a.jpg') + '") 40%, url("' + url('b.jpg') + '")) !important'
    };
    const {stack, scope} = declaredPage({host: host, imageProperty: 'background-image'});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint
    stack.driver.tick(64); // the verification
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("poster.jpg")',
        'a foreign value kept the claim');
});

// Every sharper rung of an img frame rides srcset and sizes — the
// authored width and height attributes do not pin a box CSS may size
// from the image — and the src stays the frame's base.
test('a sized img sharpens through srcset and sizes, never src', async function () {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(32);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(48);
    assert.strictEqual(host.getAttribute('srcset'), url('fHD.jpg') + ' 1600w', 'the sharper rung rides srcset');
    assert.strictEqual(host.getAttribute('sizes'), '800px', 'sizes is the base frame\'s intrinsic width');
    assert.strictEqual(host.getAttribute('src'), 'f0.jpg', 'the sharper rung was written as src');
});

// The module withdraws only the srcset and sizes values it wrote: a
// srcset another script set since stays, and so does its sizes.
test('a srcset another script wrote survives the module\'s withdrawal', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        resolution: true,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(32);
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(48);
    assert.ok(host.hasAttribute('srcset'), 'the module never sharpened');
    host.setAttribute('srcset', 'page.jpg 2x');
    host.setAttribute('sizes', '100vw');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(64);
    await settleAll(stack.images, 800, 450);
    stack.driver.tick(80);
    assert.strictEqual(host.getAttribute('srcset'), 'page.jpg 2x', 'another script\'s srcset was removed');
    assert.strictEqual(host.getAttribute('sizes'), '100vw', 'another script\'s sizes was removed');
});

// An img src as a page reflects it: the property answers the content
// attribute resolved against the document, and an empty attribute
// resolves to the document's own URL.
function browserSrc(host) {
    host.reflectsSrc = true;
    Object.defineProperty(host, 'src', {
        configurable: true,
        get: function () {
            const value = this.getAttribute('src');
            return value === null ? '' : new URL(value, 'http://localhost/').href;
        },
        set: function (value) {
            this.setAttribute('src', String(value));
        }
    });
    return host;
}

// An empty src attribute is no baseline, whatever the src property
// answers for it.
test('an img host with an empty src attribute is rejected and reported', async function () {
    FakeSubscription.reset();
    const host = browserSrc(new Element('img', 'host'));
    host.setAttribute('src', '');
    host.setAttribute('width', '800');
    host.setAttribute('height', '450');
    const {stack, scope, reports} = declaredPage({host: host, noSrc: true});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'an empty src bound a sequence');
    assert.strictEqual(host.getAttribute('src'), '', 'the empty src was rewritten');
    const kept = await reportsAfterATurn(reports);
    assert.strictEqual(kept.length, 1, 'the empty src is reported once');
    assert.strictEqual(kept[0].name, 'TypeError');
    assert.strictEqual(kept[0].message,
        'paste.ui.imagesequence #host: data-paste-imagesequence on an img requires an authored src baseline');
});

// The baseline that comes back is the src attribute exactly as
// authored — relative stays relative.
test('a restored img gets its authored src attribute back verbatim', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const host = browserSrc(new Element('img', 'host'));
    host.setAttribute('src', 'f0.jpg');
    host.setAttribute('width', '800');
    host.setAttribute('height', '450');
    const {stack, scope} = declaredPage({
        host: host,
        noSrc: true,
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(host.getAttribute('src'), url('f2.jpg'), 'the frame never painted');
    motion.set(true);
    stack.driver.tick(64);
    assert.strictEqual(host.getAttribute('src'), 'f0.jpg', 'the authored attribute did not come back verbatim');
});

// A layered authored background — a gradient beside a url() — is not a
// presentation one frame can stand in for: malformed, left as authored,
// reported once.
test('a layered authored background is malformed', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.computedStyle = {'background-image': 'linear-gradient(red, blue), url("' + url('f0.jpg') + '")'};
    const {stack, scope, reports} = declaredPage({host: host, imageProperty: 'background-image'});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'a layered baseline bound a sequence');
    assert.strictEqual(host.style.getPropertyValue('background-image'), '', 'a layered baseline was painted over');
    const kept = await reportsAfterATurn(reports);
    assert.strictEqual(kept.length, 1, 'the layered baseline is reported once');
    assert.ok(kept[0] instanceof TypeError || kept[0].name === 'TypeError');
    assert.ok(kept[0].message.indexOf('paste.ui.imagesequence #host: ') === 0, kept[0].message);
});

// The request attributes follow the declared property, not the tag: an
// img declared to paint its background carries none.
test('an img painting its background adds no request attributes', function () {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.setAttribute('crossorigin', 'use-credentials');
    host.setAttribute('referrerpolicy', 'no-referrer');
    const {stack} = declaredPage({host: host, baseline: null, imageProperty: 'background-image'});
    stack.driver.tick(16);
    assert.ok(stack.images.length > 0, 'preparation started');
    stack.images.forEach(function (image) {
        assert.strictEqual(image.crossOrigin, null, 'crossorigin copied for a background paint');
        assert.strictEqual(image.referrerPolicy, '', 'referrerpolicy copied for a background paint');
    });
});

// The single-frame exception holds for a gate whose set is just the
// desired frame: a gate of one, or a larger gate clipped to one at its
// endpoint.
test('an oversized frame alone in its gate still admits and paints', async function () {
    const run = async function (frames, offset) {
        FakeSubscription.reset();
        const host = new Element('i', 'host');
        host.computedStyle = {'background-size': 'cover'};
        const {stack} = declaredPage({
            host: host,
            baseline: null,
            imageProperty: 'background-image',
            scrubBuffer: frames,
            hostRect: {top: 0, bottom: 400, left: 0, right: 600, width: 600, height: 400},
            scopeRect: {top: 1600 - offset, bottom: 1800 - offset, width: 600, height: 200},
            catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
                return {src: 'big' + index + '.jpg', width: 3000, height: 3000};
            })}
        });
        stack.window.pageYOffset = offset;
        let at = 16;
        stack.driver.tick(at);
        for (let round = 0; round < 4; round += 1) {
            await settleAll(stack.images, 3000, 3000);
            stack.driver.tick(at += 16);
        }
        return host.style.getPropertyValue('background-image');
    };
    assert.strictEqual(await run(1, 0), 'url("' + url('big0.jpg') + '")', 'a gate of one froze the oversized frame');
    assert.strictEqual(await run(3, 1800), 'url("' + url('big3.jpg') + '")',
        'a gate clipped to one froze the oversized frame');
});

// Reduced motion arriving closes the scrub gate: when motion returns,
// a new desire waits for its whole set again instead of painting the
// moment its own frame is ready.
test('a return from reduced motion re-funds the scrub gate', async function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    const {stack, scope, host} = declaredPage({
        scrubBuffer: 2,
        window: {matchMedia: function () { return motion; }},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {src: 'f' + index + '.jpg', width: 800, height: 450};
        })}
    });
    let at = 16;
    stack.driver.tick(at);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    stack.driver.tick(at += 16);
    motion.set(true);
    stack.driver.tick(at += 16); // the stand-down
    stack.driver.tick(at += 16); // adoption
    motion.set(false);
    stack.driver.tick(at += 16);
    // Frame 1 lands; frame 0's proof and frame 2 stay in flight.
    stack.images.forEach(function (image) {
        if (image.src === url('f1.jpg') && !image.landed) {
            image.landed = true;
            image.succeed(800, 450);
        }
    });
    await settlePromises();
    stack.driver.tick(at += 16);
    scrollFraction(stack, scope, 800 + 1000 * 1.5 / 6); // desired 1 — gate {1, 2}
    stack.driver.tick(at += 16);
    stack.driver.tick(at += 16);
    assert.strictEqual(presented(host), url('f0.jpg'), 'the returning gate painted without its set');
});

// The borrowed tabindex outlives a blur the window's own focus loss
// delivers while the scope is still the focused element; it goes back
// when focus really leaves.
test('a window blur keeps the borrowed tabindex', async function () {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    assert.strictEqual(stack.document.activeElement, scope, 'focus moved to the scope');
    assert.strictEqual(scope.getAttribute('tabindex'), '-1');
    scope.fireEvent('blur');
    assert.strictEqual(scope.getAttribute('tabindex'), '-1', 'a window blur returned the tabindex');
    scope.blur();
    scope.fireEvent('blur');
    assert.strictEqual(scope.hasAttribute('tabindex'), false, 'the tabindex outlived the real blur');
});

// A fault in the read phase only marks the host: ending its intro — a
// write — waits for the write phase, and the host asks for no frame of
// its own.
test('a read-phase fault defers its writes and asks for no frame', async function () {
    FakeSubscription.reset();
    const {stack, host, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'},
        skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro never started');
    let phase = null;
    const writes = [];
    stack.driver.onPhase = function (name) { phase = name; };
    const setAttribute = skip.setAttribute.bind(skip);
    skip.setAttribute = function (name, value) {
        writes.push(phase);
        setAttribute(name, value);
    };
    host.getBoundingClientRect = function () { throw new Error('hostile layout read'); };
    assert.doesNotThrow(function () { stack.driver.tick(132); }, 'the read-phase throw escaped');
    assert.deepStrictEqual(writes, ['write'], 'the intro ended outside the write phase');
    assert.strictEqual(skip.getAttribute('hidden'), '', 'the faulted intro kept its control');
    assert.strictEqual(stack.driver.pending(), 0, 'the faulted host asked for a frame of its own');
});

// Empty scope, trigger and easing attributes are malformed, never the
// default.
test('empty scope, trigger and easing declarations stay inert', async function () {
    const run = async function (name) {
        FakeSubscription.reset();
        const {stack, scope, host, reports} = declaredPage({
            intro: {from: 0, to: 3, durationMs: 3000}
        });
        host.setAttribute(name, '');
        const reopened = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
        reopened.driver.tick(16);
        await settleAll(reopened.images);
        scrollFraction(reopened, scope, 1300);
        reopened.driver.tick(32);
        await settleAll(reopened.images);
        reopened.driver.tick(48);
        assert.strictEqual(reopened.images.length, 0, 'an empty ' + name + ' bound a sequence');
        assert.strictEqual(presented(host), url('f0.jpg'));
        const kept = await reportsAfterATurn(reopened.reports);
        assert.strictEqual(kept.length, 1, 'an empty ' + name + ' is reported once');
        return [stack, reports];
    };
    await run('data-sequence-scrub');
    await run('data-sequence-intro-trigger');
    await run('data-sequence-intro-easing');
});

// One URL repeated across the catalog is one decoded image, and its
// group ranks by its nearest holder: a hold frame just ahead is never
// evicted for its far twin's distance and then fetched again.
test('an alias group ranks by its nearest holder', async function () {
    FakeSubscription.reset();
    const frames = [];
    for (let index = 0; index < 60; index += 1) {
        if ((index >= 24 && index <= 26) || index === 59) {
            frames.push({src: 'hold.jpg', width: 1000, height: 1000});
        } else {
            frames.push({src: 'f' + index + '.jpg', width: 1000, height: 1000,
                upgrades: [{src: 'u' + index + '.jpg', width: 1100, height: 1100}]});
        }
    }
    const {stack, scope, host} = declaredPage({
        baseline: null,
        resolution: true,
        catalogDocument: {frames: frames},
        hostRect: {top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500}
    });
    let at = 16;
    const go = function (index) {
        scrollFraction(stack, scope, 800 + 1000 * (index + 0.5) / 60);
        stack.driver.tick(at += 16);
    };
    const settle = async function () {
        for (let round = 0; round < 4; round += 1) {
            stack.images.forEach(function (image) {
                if (!image.landed) {
                    image.landed = true;
                    image.succeed(1, 1);
                }
            });
            await settlePromises();
            stack.driver.tick(at += 16);
        }
    };
    go(18);
    await settle();
    go(22);
    await settle();
    // The painted box grows: every selection is now its sharper rung.
    host.rect = {top: 0, bottom: 1100, left: 0, right: 1100, width: 1100, height: 1100};
    go(23);
    await settle();
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('hold.jpg');
    }).length, 1, 'the near hold frame was evicted and fetched again');
});

// A preparation refused before its source was assigned — here a
// crossOrigin setter that throws — requested nothing: the URL is not
// poisoned, and the next input asks for it again.
test('a preparation refused before its request is no verdict on the URL', async function () {
    FakeSubscription.reset();
    const registry = imageRegistry();
    let refuse = true;
    const Image = function () {
        const image = registry.Image();
        let crossOrigin = null;
        Object.defineProperty(image, 'crossOrigin', {
            configurable: true,
            get: function () { return crossOrigin; },
            set: function (value) {
                if (refuse) {
                    throw new Error('hostile crossOrigin');
                }
                crossOrigin = value;
            }
        });
        return image;
    };
    const host = new Element('img', 'host');
    host.setAttribute('crossorigin', 'anonymous');
    host.setAttribute('width', '800');
    host.setAttribute('height', '450');
    const {stack, scope} = declaredPage({host: host, window: {Image: Image}});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(registry.images.length, 0, 'a refused preparation reached a URL');
    refuse = false;
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.ok(registry.images.some(function (image) { return image.src === url('f2.jpg'); }),
        'the refused URL was poisoned for the page\'s life');
});

// A closed gate's dead verdict is remembered with the standing image's
// proof: proof landing for the standing image is a change, and the set
// it now funds is re-priced without another input.
test('a standing proof landing re-prices a dead gate', async function () {
    FakeSubscription.reset();
    const {stack, host} = declaredPage({
        baseline: 'u0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: Array.from({length: 4}, function (_, index) {
            if (index === 0) {
                return {src: 'b0.jpg', width: 800, height: 800,
                    upgrades: [{src: 'u0.jpg', width: 2600, height: 2600}]};
            }
            return {src: 'b' + index + '.jpg', width: 1000, height: 1000};
        })}
    });
    stack.driver.tick(16);
    const proof = stack.images.filter(function (image) { return image.src === url('u0.jpg'); })[0];
    assert.ok(proof, 'the standing image\'s proof never started');
    assert.ok(!stack.images.some(function (image) { return image.src === url('b1.jpg'); }),
        'the unproven standing image funded the set');
    proof.succeed(2600, 2600);
    await settlePromises();
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.ok(stack.images.some(function (image) { return image.src === url('b1.jpg'); }),
        'the proven standing image left the gate dead');
    assert.strictEqual(presented(host), url('u0.jpg'));
});

// A motion answer that throws never escapes the pass nor wedges it:
// once the answer reads again the scene scrubs on the next input.
test('a throwing motion answer never wedges the pass', async function () {
    FakeSubscription.reset();
    let throwing = false;
    const motion = mediaQueryList();
    const query = {
        addEventListener: motion.addEventListener,
        removeEventListener: motion.removeEventListener
    };
    Object.defineProperty(query, 'matches', {
        get: function () {
            if (throwing) {
                throw new Error('hostile matches');
            }
            return false;
        }
    });
    const {stack, scope, host} = declaredPage({
        window: {matchMedia: function () { return query; }}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    throwing = true;
    scrollFraction(stack, scope, 1300);
    assert.doesNotThrow(function () { stack.driver.tick(32); }, 'the motion read escaped the pass');
    await settleAll(stack.images);
    assert.doesNotThrow(function () { stack.driver.tick(48); }, 'the motion read escaped the pass');
    throwing = false;
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(64);
    await settleAll(stack.images);
    stack.driver.tick(80);
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('f2.jpg'), 'the pass wedged after the throwing read');
});

// Ending an intro is all or nothing: a skip control whose surface
// refuses the hidden write, and a timer that refuses the clear, neither
// escape the click nor leave the phase half-ended.
test('an intro ends completely when its control and timer refuse', async function () {
    FakeSubscription.reset();
    const {stack, scope, host, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', bufferMs: 3000, skip: '#skip'},
        skipId: 'skip',
        window: {clearTimeout: function () { throw new Error('hostile clearTimeout'); }}
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    await settleAll(stack.images);
    stack.driver.tick(132);
    assert.strictEqual(skip.hasAttribute('hidden'), false, 'the intro never started');
    skip.setAttribute = function () { throw new Error('hostile control'); };
    assert.doesNotThrow(function () { skip.fireEvent('click'); }, 'the skip escaped its handler');
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(148);
    await settleAll(stack.images);
    stack.driver.tick(164);
    assert.strictEqual(presented(host), url('f3.jpg'), 'scroll never took ownership');
    skip.fireEvent('click');
    assert.ok(FakeSubscription.registry.every(function (subscription) {
        return subscription.name !== 'click' || subscription.disposed;
    }), 'the skip handler outlived the intro');
});

// A timer that refuses at define loses the report, never the sweep:
// the later host still binds.
test('a refusing timer loses the report, never a later host', async function () {
    FakeSubscription.reset();
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const bad = new Element('img', 'bad');
    bad.src = 'f0.jpg';
    bad.setAttribute('data-paste-imagesequence', 'frames');
    const good = new Element('div', 'good');
    good.setAttribute('data-paste-imagesequence', '#frames');
    good.rect = {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450};
    scope.appendChild(bad);
    scope.appendChild(good);
    scope.appendChild(scriptJson('frames', catalog(4)));
    let stack;
    assert.doesNotThrow(function () {
        stack = openUiStack({
            elements: {scope: scope},
            scrollscrub: true,
            imagesequence: true,
            window: {setTimeout: function () { throw new Error('hostile timer'); }}
        });
    }, 'a refused report escaped the define sweep');
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48);
    assert.strictEqual(good.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'the host after the refused report never bound');
});

// A container-type is a token list: an ancestor declaring a size
// container alongside another feature is a query container too.
test('a combined container-type is watched like a plain one', function () {
    FakeSubscription.reset();
    const outer = new Element('div', 'outer');
    const container = new Element('div', 'container');
    container.computedStyle = {'container-type': 'inline-size scroll-state'};
    outer.appendChild(container);
    const {stack, scope} = declaredPage({resolution: true});
    scope.parentNode.removeChild(scope);
    container.appendChild(scope);
    const reopened = openStack({elements: {outer: outer}, scrollscrub: true, imagesequence: true});
    assert.ok(stack, 'the page opened');
    assert.ok(reopened.resizeObservers.some(function (observer) {
        return observer.observed.indexOf(container) >= 0;
    }), 'the combined container-type was not watched');
});

// Decimal attributes take a bare fraction or a trailing point, and no
// surrounding whitespace.
test('decimal attributes take a bare fraction and a trailing point', async function () {
    const run = async function (name, value) {
        FakeSubscription.reset();
        const {scope, host} = declaredPage({});
        host.setAttribute(name, value);
        const reopened = openStack({elements: {scope: scope}, scrollscrub: true, imagesequence: true});
        reopened.driver.tick(16);
        await settleAll(reopened.images);
        return reopened.images.length > 0;
    };
    assert.strictEqual(await run('data-sequence-intro-buffer-ms', '.5'), true, '.5 was refused');
    assert.strictEqual(await run('data-sequence-intro-buffer-ms', '3000.'), true, '3000. was refused');
    assert.strictEqual(await run('data-sequence-intro-duration-ms', '3000.'), true, '3000. was refused');
    assert.strictEqual(await run('data-sequence-intro-buffer-ms', ' 30'), false, 'surrounding whitespace was accepted');
    assert.strictEqual(await run('data-sequence-to', '2 '), false, 'surrounding whitespace was accepted');
    assert.strictEqual(await run('data-sequence-scrub-buffer-frames', '1.'), false, 'a whole number took a point');
});

// A delivery whose entry count is not a finite whole number is no
// delivery at all.
test('a runaway observer delivery is ignored', function () {
    FakeSubscription.reset();
    const {stack} = declaredPage({});
    stack.driver.tick(16);
    let reads = 0;
    const entries = new Proxy({}, {
        get: function (target, key) {
            if (key === 'length') {
                return Infinity;
            }
            reads += 1;
            if (reads > 1000) {
                throw new Error('runaway delivery');
            }
            return undefined;
        }
    });
    stack.resizeObservers.forEach(function (observer) {
        assert.doesNotThrow(function () { observer.callback(entries, observer); }, 'the delivery ran away');
    });
    assert.strictEqual(reads, 0, 'an unbounded delivery was walked');
});

// A scene whose root is a nested scroller is measured against the page
// viewport too: far below the fold it does nothing, and the page's own
// scroll bringing it near is an input of its own.
test('a nested root scene re-evaluates its band on a page scroll', function () {
    FakeSubscription.reset();
    const scroller = new Element('div', 'scroller');
    scroller.rect = {top: 10000, bottom: 10400, width: 600, height: 400};
    scroller.clientHeight = 400;
    scroller.scrollHeight = 3000;
    const scope = new Element('section', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-root', '#scroller');
    scope.rect = {top: 10500, bottom: 11500, width: 600, height: 1000};
    const host = new Element('i', 'host');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.rect = {top: 10500, bottom: 10900, left: 0, right: 600, width: 600, height: 400};
    scope.appendChild(host);
    scope.appendChild(scriptJson('frames', catalog(12)));
    scroller.appendChild(scope);
    const stack = openStack({elements: {scroller: scroller}, scrollscrub: false, imagesequence: true});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'a scene far below the page viewport prepared frames');
    stack.window.pageYOffset = 9900;
    scroller.rect = {top: 100, bottom: 500, width: 600, height: 400};
    scope.rect = {top: 600, bottom: 1600, width: 600, height: 1000};
    host.rect = {top: 600, bottom: 1000, left: 0, right: 600, width: 600, height: 400};
    stack.window.fireEvent('scroll');
    stack.driver.tick(32);
    assert.ok(stack.images.length > 0, 'the page scroll never re-evaluated the nested scene');
});

// Under reduced motion the static baseline stands: a scroll asks for no
// pass on a host that has nothing left to refine.
test('a scroll under reduced motion asks for no pass', function () {
    FakeSubscription.reset();
    const motion = mediaQueryList();
    motion.matches = true;
    const {stack, scope} = declaredPage({
        scrollscrub: false,
        window: {matchMedia: function () { return motion; }}
    });
    stack.driver.tick(16);
    stack.driver.tick(32);
    assert.strictEqual(stack.driver.pending(), 0, 'the static page kept a pass armed');
    scrollFraction(stack, scope, 1300);
    assert.strictEqual(stack.driver.pending(), 0, 'a scroll under reduced motion asked for a pass');
});

// The pass reads the motion preference once, in its read phase, and
// every later decision in the same pass uses that answer.
test('a pass reads the motion preference once', async function () {
    FakeSubscription.reset();
    let reads = 0;
    const motion = mediaQueryList();
    const query = {
        addEventListener: motion.addEventListener,
        removeEventListener: motion.removeEventListener
    };
    Object.defineProperty(query, 'matches', {
        get: function () {
            reads += 1;
            return false;
        }
    });
    const {stack, scope} = declaredPage({
        resolution: true,
        scrubBuffer: 2,
        upgrades: [{src: 'fHD.jpg', width: 1600, height: 900}],
        window: {matchMedia: function () { return query; }}
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    reads = 0;
    stack.driver.tick(32);
    assert.strictEqual(reads, 1, 'one pass read the live preference ' + reads + ' times');
});

// One computed-style read per host per read phase: the claim's evidence
// and the policy snapshot share it.
test('a read phase reads a host\'s computed style once', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const counts = new Map();
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                counts.set(element, (counts.get(element) || 0) + 1);
                return {
                    getPropertyValue: function (name) {
                        return element.style ? element.style.getPropertyValue(name) : '';
                    }
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint — a claim now pending
    scrollFraction(stack, scope, 1300); // and a dirty scene for the same read phase
    counts.clear();
    stack.driver.tick(64);
    assert.strictEqual(counts.get(host), 1, 'the read phase read the host\'s style ' + counts.get(host) + ' times');
});

// A refused claim reverts both the inline layer and the bookkeeping,
// and stays refused: the passes after the revert neither repaint the
// refused frame nor loop; a fresh input after the stylesheet stops
// outranking the inline layer paints the desired frame again.
test('a refused claim stays reverted across later passes', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("poster.jpg")');
    host.computedStyle = {'background-image': 'url("' + url('sheet.jpg') + '") !important'};
    const {stack, scope} = declaredPage({host: host, imageProperty: 'background-image'});
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint
    stack.driver.tick(64); // the verification
    const writes = [];
    const setProperty = host.style.setProperty.bind(host.style);
    host.style.setProperty = function (name, value, priority) {
        writes.push(value);
        setProperty(name, value, priority);
    };
    let at = 64;
    for (let round = 0; round < 5; round += 1) {
        stack.driver.tick(at += 16);
        await settlePromises();
    }
    assert.deepStrictEqual(writes, [], 'the refused frame was painted again without an input');
    assert.strictEqual(stack.driver.pending(), 0, 'the refusal kept the owner busy');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("poster.jpg")');
    host.computedStyle = {};
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f2.jpg') + '")',
        'the reverted bookkeeping kept the refused frame as displayed');
});

// A fault is one pass's verdict: the next pass starts the host afresh,
// so its later claims are verified and its follow-up frames requested
// as for any other host.
test('a host that faulted once runs normally afterwards', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("poster.jpg")');
    host.computedStyle = {'background-image': 'url("' + url('sheet.jpg') + '") !important'};
    let hostile = true;
    const rect = {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450};
    host.getBoundingClientRect = function () {
        if (hostile) {
            hostile = false;
            throw new Error('one hostile layout read');
        }
        return rect;
    };
    const {stack, scope} = declaredPage({host: host, imageProperty: 'background-image'});
    stack.driver.tick(16);
    assert.strictEqual(hostile, false, 'the hostile read never ran');
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    stack.driver.tick(48); // the paint
    stack.driver.tick(64); // the verification
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("poster.jpg")',
        'a claim made after the fault was never verified');
});

// A source failure is a change to a closed gate's dead verdict: a set
// that could not fund at its selected rungs re-prices when a rung fails
// and its fallback fits — without another input.
test('a failed rung re-prices a dead gate', async function () {
    FakeSubscription.reset();
    const {stack, scope} = declaredPage({
        baseline: null,
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 1700, left: 0, right: 1700, width: 1700, height: 1700},
        catalogDocument: {frames: Array.from({length: 6}, function (_, index) {
            return {src: 'b' + index + '.jpg', width: 400, height: 400,
                upgrades: [{src: 'u' + index + '.jpg', width: 1700, height: 1700}]};
        })}
    });
    const land = async function (src) {
        stack.images.forEach(function (image) {
            if (image.src === url(src) && !image.landed) {
                image.landed = true;
                image.succeed(1700, 1700);
            }
        });
        await settlePromises();
    };
    stack.driver.tick(16);
    await land('u0.jpg');
    await land('u1.jpg');
    stack.driver.tick(32);
    scrollFraction(stack, scope, 800 + 1000 * 1.5 / 6); // desired 1, gate open
    stack.driver.tick(48);
    const u2 = stack.images.filter(function (image) { return image.src === url('u2.jpg'); })[0];
    assert.ok(u2, 'the lookahead never reached frame 2');
    scrollFraction(stack, scope, 800 + 1000 * 2.5 / 6); // desired 2 — {2, 3} cannot fund
    stack.driver.tick(64);
    assert.ok(!stack.images.some(function (image) { return image.src === url('u3.jpg'); }),
        'the unfundable set admitted a member');
    u2.fail();
    await settlePromises();
    stack.driver.tick(80);
    stack.driver.tick(96);
    assert.ok(stack.images.some(function (image) { return image.src === url('b2.jpg'); }),
        'the fallback that now funds the set was never requested');
});

// An open gate stays open at the standing index even when a policy
// change leaves the standing frame short of its selection: the next
// frame paints as soon as it is ready, with no set to re-fund.
test('an open gate survives a policy change at the standing index', async function () {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        baseline: 's0.jpg',
        resolution: true,
        scrubBuffer: 2,
        hostRect: {top: 0, bottom: 400, left: 0, right: 400, width: 400, height: 400},
        catalogDocument: {frames: Array.from({length: 3}, function (_, index) {
            return {src: 's' + index + '.jpg', width: 400, height: 400,
                upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 1600}]};
        })}
    });
    stack.driver.tick(16);
    await settleAll(stack.images, 400, 400);
    stack.driver.tick(32);
    await settleAll(stack.images, 400, 400);
    stack.driver.tick(48);
    host.rect = {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(64);
    stack.images.forEach(function (image) {
        if (image.src === url('u1.jpg') && !image.landed) {
            image.landed = true;
            image.succeed(1600, 1600);
        }
    });
    await settlePromises();
    stack.driver.tick(80);
    scrollFraction(stack, scope, 1300); // desired 1
    stack.driver.tick(96);
    assert.strictEqual(presented(host), url('u1.jpg'), 'the open gate closed at its own standing index');
});

for (const outcome of ['loaded', 'network error', 'decode error', 'throwing then']) {
    test('sequence preparation releases both native listeners after ' + outcome, async () => {
        FakeSubscription.reset();
        const {stack, host} = declaredPage({catalogDocument: catalog(1), baseline: null, scrollscrub: false});
        stack.driver.tick(16);
        assert.equal(stack.images.length, 1, 'the first frame must start');
        const image = stack.images[0];
        const subscriptions = FakeSubscription.registry.filter(subscription => subscription.target === image);
        assert.equal(subscriptions.length, 2);
        assert.ok(subscriptions.every(subscription => subscription.isBound()));
        if (outcome === 'network error') image.fail();
        else {
            if (outcome === 'decode error') image.decodeShouldFail = true;
            if (outcome === 'throwing then') image.decode = () => ({then() { throw new Error('decode then refused'); }});
            image.succeed(800, 450);
        }
        await settlePromises();
        stack.driver.tick(32);
        assert.ok(subscriptions.every(subscription => !subscription.isBound()), 'a completed preparation retained its listeners');
        assert.equal(presented(host), outcome === 'loaded' ? url('f0.jpg') : url('poster.jpg'));
        image.succeed(800, 450);
        image.fail();
        await settlePromises();
        stack.driver.tick(48);
        assert.equal(presented(host), outcome === 'loaded' ? url('f0.jpg') : url('poster.jpg'));
    });
}

for (const sample of [
    {name: 'empty frame index', options: {sequenceFrom: ''}, message: /sequence-from must not be empty/},
    {name: 'fractional frame index', options: {sequenceFrom: 1.5}, message: /sequence-from must be an integer index within the catalog/},
    {name: 'out-of-range frame index', options: {sequenceTo: 4}, message: /sequence-to must be an integer index within the catalog/},
    {name: 'empty buffer', options: {scrubBuffer: ''}, message: /data-sequence-scrub-buffer-frames must not be empty/},
    {name: 'invalid image property', options: {imageProperty: 'poster'}, message: /data-image-property must be src or background-image/},
    {name: 'src on a background host', options: {host: new Element('div', 'host'), imageProperty: 'src'}, message: /data-image-property src requires an img host/}
]) {
    test('sequence reports the declaration error for ' + sample.name, async () => {
        FakeSubscription.reset();
        const {stack, reports} = declaredPage(sample.options);
        stack.driver.tick(16);
        const errors = await reportsAfterATurn(reports);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, sample.message);
        assert.equal(stack.images.length, 0, 'a malformed host must remain inert');
    });
}

for (const sample of [
    {name: 'plain reference', reference: 'frames', message: /must be a #fragment reference/},
    {name: 'missing element', reference: '#missing', message: /references a missing element: missing/},
    {name: 'non-script element', tag: 'div', message: /must reference a script\[type="application\/json"\] element/},
    {name: 'wrong script type', type: 'text/plain', message: /must reference a script\[type="application\/json"\] element/},
    {name: 'invalid JSON', text: '{', message: /catalog is not valid JSON/}
]) {
    test('sequence catalog reports ' + sample.name, async () => {
        FakeSubscription.reset();
        const host = new Element('img', 'invalid');
        host.src = 'poster.jpg';
        host.setAttribute('data-paste-imagesequence', sample.reference || '#invalid-frames');
        const frames = new Element(sample.tag || 'script', 'invalid-frames');
        frames.setAttribute('type', sample.type || 'application/json');
        frames.textContent = sample.text || JSON.stringify(catalog(1));
        const stack = openStack({elements: {host, frames}, imagesequence: true, scrollscrub: false});
        stack.driver.tick(16);
        const errors = await reportsAfterATurn(stack.reports);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, sample.message);
        assert.equal(stack.images.length, 0);
    });
}

for (const refusal of ['throwing decode', 'non-promise decode', 'throwing then']) {
    test('a hidden ' + refusal + ' is retried once after visibility returns', async () => {
        FakeSubscription.reset();
        const {stack, host} = declaredPage({catalogDocument: catalog(1), baseline: null, scrollscrub: false});
        stack.driver.tick(16);
        const image = stack.images[0];
        stack.document.hidden = true;
        image.decode = refusal === 'throwing decode' ? () => { throw new Error('refused'); }
            : refusal === 'non-promise decode' ? () => undefined
                : () => ({then() { throw new Error('refused'); }});
        image.succeed(800, 450);
        await settlePromises();
        stack.driver.tick(32);
        assert.equal(presented(host), url('poster.jpg'));
        assert.equal(stack.images.length, 1);
        stack.document.hidden = false;
        stack.document.fireEvent('visibilitychange');
        stack.driver.tick(48);
        assert.equal(stack.images.length, 2);
        stack.images[1].succeed(800, 450);
        await settlePromises();
        stack.driver.tick(64);
        assert.equal(presented(host), url('f0.jpg'));
    });
}

test('retiring the skip preserves authored focusability and requests no scrolling', async () => {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip'
    });
    scope.setAttribute('tabindex', '-1');
    const focus = scope.focus.bind(scope);
    const requests = [];
    scope.focus = options => { requests.push(options); focus(options); };
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    assert.deepEqual(requests.map(options => options.preventScroll), [true]);
    assert.equal(stack.document.activeElement, scope);
    scope.blur();
    scope.fireEvent('blur');
    assert.equal(scope.getAttribute('tabindex'), '-1');
    assert.equal(FakeSubscription.registry.filter(s => s.target === scope && s.name === 'blur' && s.isBound()).length, 0);
    assert.equal(FakeSubscription.registry.filter(s => s.target === stack.document && s.name === 'focusin' && s.isBound()).length, 0,
        'an authored tabindex was given a focus watcher');
});

test('a borrowed skip-focus lease releases its blur listener when focus leaves', async () => {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    const leases = FakeSubscription.registry.filter(s => s.target === scope && s.name === 'blur');
    assert.equal(leases.length, 1);
    assert.ok(leases[0].isBound());
    scope.blur();
    scope.fireEvent('blur');
    assert.ok(!leases[0].isBound());
    assert.equal(scope.hasAttribute('tabindex'), false);
});

// The watchers a borrowed scope tabindex holds: the scope's blur and
// the document's focusin.
function skipFocusWatchers(stack, scope) {
    return FakeSubscription.registry.filter(s => s.isBound() &&
        ((s.target === scope && s.name === 'blur') || (s.target === stack.document && s.name === 'focusin')));
}

// A window switch blurs the scope while it stays the focused element;
// an engine that restores that focus silently, or drops it without a
// blur, then moves focus on with no second blur. Focus arriving
// anywhere else ends the lease all the same.
test('focus arriving elsewhere ends a skip-focus lease whose blur never came', async () => {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    skip.focus();
    skip.fireEvent('click');
    assert.equal(stack.document.activeElement, scope, 'focus moved to the scope');
    assert.equal(skipFocusWatchers(stack, scope).length, 2, 'the lease watches the scope\'s blur and the document\'s focusin');
    scope.fireEvent('blur'); // the window losing focus
    stack.document.fireEvent('focusin'); // focus returning to the scope
    assert.equal(scope.getAttribute('tabindex'), '-1', 'a focusin while the scope held focus ended the lease');
    assert.equal(skipFocusWatchers(stack, scope).length, 2);
    const field = new Element('input', 'field');
    field.focus(); // focus moved on with no blur delivered to the scope
    stack.document.fireEvent('focusin');
    assert.equal(scope.hasAttribute('tabindex'), false, 'the borrowed tabindex outlived focus arriving elsewhere');
    assert.equal(skipFocusWatchers(stack, scope).length, 0, 'a focus watcher outlived the lease');
    scope.setAttribute('tabindex', '-1');
    stack.document.fireEvent('focusin');
    scope.fireEvent('blur');
    assert.equal(scope.getAttribute('tabindex'), '-1', 'a retired lease still reclaimed a tabindex');
});

// The watchers exist before focus moves: one that cannot be made leaves
// neither focus nor a borrowed tabindex on the scope, the watcher that
// was made goes too, and the retiring control is still blurred.
test('a skip-focus lease that cannot watch focus borrows nothing', async () => {
    FakeSubscription.reset();
    const {stack, scope, skip} = declaredPage({
        intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip'
    });
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    const add = stack.document.addEventListener;
    stack.document.addEventListener = function (name, listener) {
        if (name === 'focusin') {
            throw new Error('refused');
        }
        return add.call(this, name, listener);
    };
    skip.focus();
    skip.fireEvent('click');
    assert.equal(skip.getAttribute('hidden'), '', 'the skip retires');
    assert.notEqual(stack.document.activeElement, skip, 'focus stayed on the hidden control');
    assert.notEqual(stack.document.activeElement, scope, 'focus moved without a lease to end it');
    assert.equal(scope.hasAttribute('tabindex'), false, 'the borrowed tabindex was left behind');
    assert.equal(skipFocusWatchers(stack, scope).length, 0, 'the watcher that was made outlived the failure');
});

// ResizeObserver reports sizes, not positions: a late image or font can
// move the subject inside a box whose size never changes, and no scroll
// or resize carries the shift. A sequence bound while the document
// loads re-measures once at its load — the input scrollscrub also takes
// — and the subscription retires with that one delivery.
test('a sequence bound before the document load re-measures once when it fires', async () => {
    FakeSubscription.reset();
    const {stack, scope, host} = declaredPage({
        document: {readyState: 'interactive'},
        scrollscrub: false
    });
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1300); // progress 0.5 — frame 2
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.equal(presented(host), url('f2.jpg'));
    // The subject moves 250 down with no input: progress 0.25 — frame 1.
    scope.rect = {top: 550, bottom: 750, width: 100, height: 200};
    stack.driver.tick(80);
    assert.equal(presented(host), url('f2.jpg'), 'something other than load re-measured');
    const loadInputs = FakeSubscription.registry.filter(s => s.name === 'load' && s.target === stack.window);
    assert.equal(loadInputs.length, 1, 'no load re-measure was subscribed');
    stack.window.fireEvent('load');
    stack.driver.tick(96);
    await settleAll(stack.images);
    stack.driver.tick(112);
    assert.equal(presented(host), url('f1.jpg'), 'the load left the frame of the pre-load geometry');
    assert.ok(!loadInputs[0].isBound(), 'the load subscription outlived its one delivery');
    // A second load is no input: the subscription retired.
    scope.rect = {top: 300, bottom: 500, width: 100, height: 200};
    stack.window.fireEvent('load');
    stack.driver.tick(128);
    await settleAll(stack.images);
    stack.driver.tick(144);
    assert.equal(presented(host), url('f1.jpg'), 'a second load re-measured');
});

// Bound after load, the first pass measured settled geometry: there is
// no load to wait for and no subscription for it.
test('a sequence bound after the document load subscribes to no load', () => {
    FakeSubscription.reset();
    const {stack} = declaredPage({scrollscrub: false});
    stack.driver.tick(16);
    assert.ok(!FakeSubscription.registry.some(s => s.name === 'load' && s.target === stack.window),
        'a sequence bound after load subscribed to it');
});

test('one failed resize-observer construction leaves sequence scroll inputs working', async () => {
    let attempts = 0;
    const {stack, scope, host} = declaredPage({scrollscrub: false, window: {
        ResizeObserver: function () { attempts += 1; throw new Error('refused'); }
    }});
    stack.driver.tick(16);
    await settleAll(stack.images);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    assert.equal(presented(host), url('f2.jpg'));
    assert.equal(attempts, 1);
});

for (const legacyType of [0, 2]) {
    test('legacy navigation type ' + legacyType + ' respects recorded intro consumption', async () => {
        const {stack, skip} = declaredPage({sequenceFrom: 3, sequenceTo: 0,
            intro: {from: 0, to: 3, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip',
            window: {performance: {navigation: {type: legacyType}},
                sessionStorage: {getItem: () => '1', setItem() {}}}});
        stack.driver.tick(100);
        await settleAll(stack.images);
        stack.driver.tick(116);
        assert.equal(skip.hasAttribute('hidden'), legacyType === 2);
    });
}

for (const ancestorTag of ['picture', 'div']) {
    test('native picture ancestry ' + ancestorTag + ' controls sequence activation', () => {
        FakeSubscription.reset();
        const host = new Element('img', 'host');
        const parent = new Element(ancestorTag, 'parent');
        parent.appendChild(host);
        const scope = new Element('div', 'native-scope');
        scope.setAttribute('data-paste-scrollscrub', '');
        scope.appendChild(parent);
        host.src = 'poster.jpg';
        host.setAttribute('data-paste-imagesequence', '#native-frames');
        scope.appendChild(scriptJson('native-frames', catalog(1)));
        const stack = openStack({elements: {scope}, imagesequence: true, scrollscrub: false});
        stack.driver.tick(16);
        assert.equal(stack.images.length, ancestorTag === 'picture' ? 0 : 1);
        if (ancestorTag === 'picture') {
            assert.equal(stack.resizeObservers.length, 0);
            assert.equal(FakeSubscription.registry.length, 0);
        }
    });
}

for (const alias of [false, true]) {
    test('buffered resolution remains usable through policy changes and reversal with aliases ' + alias, async () => {
        const frames = Array.from({length: 8}, (_, index) => {
            const resource = alias && index === 5 ? 2 : index;
            return {src: 'base' + resource + '.jpg', width: 800, height: 800,
                upgrades: [{src: 'sharp' + resource + '.jpg', width: 1600, height: 1600}]};
        });
        const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: 1,
            catalogDocument: {frames}, hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600}});
        let at = 0;
        const land = async () => {
            for (let round = 0; round < 12; round += 1) {
                stack.driver.tick(at += 16);
                for (const image of stack.images) {
                    if (!image.landed) {
                        image.landed = true;
                        const size = image.src.includes('sharp') ? 1600 : 800;
                        image.succeed(size, size);
                    }
                }
                await settlePromises();
            }
        };
        for (const [index, size] of [[0,1600], [1,1600], [3,800], [5,800], [4,1600], [2,1600], [7,800], [0,1600]]) {
            host.rect.width = host.rect.height = size;
            host.rect.right = host.rect.bottom = size;
            stack.window.fireEvent('resize');
            scrollFraction(stack, scope, 800 + (index + 0.25) / frames.length * 1000);
            await land();
            const expected = new Set([url(frames[index].src), url(frames[index].upgrades[0].src)]);
            assert.ok(expected.has(presented(host)), 'the desired frame must become paintable: index ' + index + ', size ' + size + ', actual ' + presented(host));
            if (size === 1600) assert.equal(presented(host), url(frames[index].upgrades[0].src));
        }
        assert.deepEqual(stack.reports, []);
    });
}

for (const document of [
    {frames: []},
    {frames: [{src: 'f0.jpg', width: 0, height: 100}]},
    {frames: [{src: 'f0.jpg', width: 100, height: 100, upgrades: [{src: 'u0.jpg', width: 50, height: 50}]}]},
    {frames: [{src: 'f0.jpg', width: 100, height: 100, upgrades: [{src: 'u0.jpg', width: 200, height: 100}]}]}
]) {
    test('an invalid catalog reports its metadata error: ' + JSON.stringify(document), async () => {
        const {stack, reports, host} = declaredPage({catalogDocument: document, baseline: null});
        stack.driver.tick(16);
        const errors = await reportsAfterATurn(reports);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /catalog|dimensions|upgrades/);
        assert.equal(stack.images.length, 0);
        assert.equal(presented(host), url('poster.jpg'));
    });
}

test('default scroll endpoints record the same consumed intro identity as explicit endpoints', async () => {
    const stored = new Map();
    const {stack} = declaredPage({intro: {from: 0, to: 3, durationMs: 3000},
        window: {sessionStorage: {getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value)}}});
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.equal(stored.get(introSessionKey('http://localhost/', '#frames|0-3|0-3', 'host')), '1');
});

test('a zero-duration intro leaves its declared skip hidden and installs no skip handler', async () => {
    const {stack, host, skip} = declaredPage({baseline: null,
        intro: {from: 0, to: 3, durationMs: 0, skip: '#skip'}, skipId: 'skip'});
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.equal(presented(host), url('f0.jpg'));
    assert.equal(skip.hasAttribute('hidden'), true);
    assert.equal(FakeSubscription.registry.some(s => s.target === skip), false);
});

test('a refused sequence declaration releases its only media-query listener', async () => {
    const motion = mediaQueryList();
    const {stack, reports} = declaredPage({catalogDocument: {frames: []},
        window: {matchMedia: () => motion}});
    assert.equal((await reportsAfterATurn(reports)).length, 1);
    assert.equal(motion.listeners.length, 0);
    motion.set(true);
    assert.equal(stack.driver.pending(), 1, 'only the independently declared scrollscrub may already be queued');
    stack.driver.tick(16);
    motion.set(false);
    assert.equal(stack.driver.pending(), 0);
});

test('the declared subject is observed even when nested below the document content boxes', async () => {
    const wrapper = new Element('div', 'wrapper'), subject = new Element('div', 'subject');
    const scope = new Element('div', 'scope'), host = new Element('img', 'host');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.setAttribute('data-scrub-subject', '#subject');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.src = 'poster.jpg';
    subject.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    scope.appendChild(host);
    scope.appendChild(scriptJson('frames', catalog(4)));
    wrapper.appendChild(subject);
    wrapper.appendChild(scope);
    const stack = openStack({elements: {wrapper}, imagesequence: true, scrollscrub: false});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(presented(host), url('f0.jpg'));
    subject.rect = {top: -200, bottom: 0, width: 100, height: 200};
    stack.resizeObservers[0].trigger(subject);
    stack.driver.tick(48);
    assert.equal(presented(host), url('f3.jpg'));
});

for (const invalid of ['no scope', 'invalid skip selector', 'unresolved root']) {
    test('sequence declaration reports ' + invalid, async () => {
        const scope = new Element('div', 'scope'), host = new Element('img', 'host');
        scope.setAttribute('data-paste-scrollscrub', '');
        host.setAttribute('data-paste-imagesequence', '#frames');
        host.src = 'poster.jpg';
        scope.appendChild(host);
        scope.appendChild(scriptJson('frames', catalog(4)));
        let document;
        if (invalid === 'no scope') scope.removeAttribute('data-paste-scrollscrub');
        if (invalid === 'unresolved root') scope.setAttribute('data-scrub-root', '#missing');
        if (invalid === 'invalid skip selector') {
            host.setAttribute('data-sequence-intro-duration-ms', '1000');
            host.setAttribute('data-sequence-intro-skip', '[');
            // A syntactically invalid selector throws before it can name a control.
            document = {querySelectorAll(selector) {
                if (selector === '[') throw new SyntaxError('invalid selector');
                return scope.querySelectorAll(selector);
            }};
        }
        const stack = openStack({elements: {scope}, document, imagesequence: true, scrollscrub: false});
        stack.driver.tick(16);
        const errors = await reportsAfterATurn(stack.reports);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, invalid === 'no scope' ? /no scrollscrub scope/ : invalid === 'unresolved root' ? /scrub-root/ : /usable selector/);
        assert.equal(stack.images.length, 0);
    });
}

test('an aliased authored pose adopts the declared start rather than alias frame zero', async () => {
    const motion = mediaQueryList();
    motion.matches = true;
    const shared = {src: 'shared.jpg', width: 800, height: 800,
        upgrades: [{src: 'sharp-shared.jpg', width: 1600, height: 1600}]};
    const {stack, host} = declaredPage({baseline: 'shared.jpg', sequenceFrom: 2, sequenceTo: 2, resolution: true,
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        catalogDocument: {frames: [shared, {src: 'other.jpg', width: 800, height: 800}, shared]},
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 0, 'reduced motion must not refine the nonzero declared pose');
    motion.set(false);
    stack.driver.tick(32);
    await settleAll(stack.images, 1600, 1600);
    stack.driver.tick(48);
    assert.equal(presented(host), url('sharp-shared.jpg'));
});

test('a known broken authored source is not fetched again as a sequence frame', () => {
    const host = new Element('img', 'host');
    host.complete = true;
    host.naturalWidth = host.naturalHeight = 0;
    const {stack} = declaredPage({host, catalogDocument: catalog(1), baseline: 'f0.jpg'});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 0);
    assert.equal(presented(host), url('f0.jpg'));
});

test('the first background claim recognizes its authored poster as a transition predecessor', async () => {
    const host = new Element('div', 'host');
    let lag = true;
    const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image',
        catalogDocument: catalog(1), window: {getComputedStyle(element) {
            return {getPropertyValue(name) {
                if (element === host && name === 'background-image')
                    return lag ? 'url("http://localhost/poster.jpg")' : element.style.getPropertyValue(name);
                if (element === host && name === 'transition-property') return 'background-image';
                if (element === host && name === 'transition-duration') return '1s';
                return '';
            }};
        }}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    const expected = 'url("http://localhost/f0.jpg")';
    assert.equal(host.style.getPropertyValue('background-image'), expected);
    stack.driver.tick(48);
    assert.equal(host.style.getPropertyValue('background-image'), expected);
    assert.equal(stack.driver.pending(), 1);
    lag = false;
    stack.driver.tick(64);
    assert.equal(host.style.getPropertyValue('background-image'), expected);
    assert.equal(stack.driver.pending(), 0);
});

test('a transient cap does not discard sharper buffered frames that fit the restored policy', async () => {
    const frames = Array.from({length: 6}, (_, index) => ({src: 'b' + index + '.jpg', width: 800, height: 800,
        upgrades: [{src: 'u' + index + '.jpg', width: 1536, height: 1536}]}));
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: 2,
        catalogDocument: {frames}, hostRect: {top: 0, bottom: 1536, left: 0, right: 1536, width: 1536, height: 1536}});
    let at = 0;
    const land = async () => {
        for (let round = 0; round < 4; round += 1) {
            stack.driver.tick(at += 16);
            for (const image of stack.images) if (!image.landed) {
                image.landed = true;
                const size = image.src.includes('/u') ? 1536 : 800;
                image.succeed(size, size);
            }
            await settlePromises();
        }
    };
    await land();
    assert.equal(presented(host), url('u0.jpg'));
    assert.ok(stack.images.some(image => image.src === url('u1.jpg') && image.landed));
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.window.fireEvent('resize');
    scrollFraction(stack, scope, 800 + 1.25 / 6 * 1000);
    stack.driver.tick(at += 16);
    // Pending base requests do not revoke the sharper cached pixels.
    delete host.computedStyle['--paste-resolution-max-width'];
    host.rect.width = host.rect.height = 800;
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    await land();
    assert.equal(presented(host), url('u1.jpg'));
    scrollFraction(stack, scope, 800 + 2.25 / 6 * 1000);
    await land();
    assert.equal(presented(host), url('u2.jpg'));
    for (const index of [1, 2]) assert.equal(stack.images.filter(image => image.src === url('u' + index + '.jpg')).length, 1);
});

test('an absent background never adopts a catalog resource literally named null', async () => {
    const host = new Element('div', 'host'), motion = mediaQueryList();
    motion.matches = true;
    const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image', resolution: true,
        catalogDocument: {frames: [{src: 'null', width: 800, height: 800,
            upgrades: [{src: 'sharp.jpg', width: 1600, height: 1600}]}]},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 0);
    motion.set(false);
    stack.driver.tick(32);
    assert.ok(stack.images.some(image => image.src === url('sharp.jpg')));
});

test('matching literal sequence sources remain usable without URL construction', async () => {
    const {stack, host} = declaredPage({catalogDocument: catalog(1), baseline: null, window: {URL: null}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 1);
    stack.images[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('f0.jpg'));
});

for (const evidence of ['empty', 'foreign gradient']) {
    test('a first background claim handles ' + evidence + ' computed evidence under a transition', async () => {
        const host = new Element('div', 'host');
        let pendingEvidence = false;
        const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image', catalogDocument: catalog(1),
            window: {getComputedStyle(element) {
                return {getPropertyValue(name) {
                    if (element === host && name === 'background-image') {
                        if (pendingEvidence) return evidence === 'empty' ? '' : 'linear-gradient(red, blue)';
                        return 'url("http://localhost/poster.jpg")';
                    }
                    if (element === host && name === 'transition-property') return 'background-image';
                    if (element === host && name === 'transition-duration') return '1s';
                    return '';
                }};
            }}});
        stack.driver.tick(16);
        await settleAll(stack.images);
        stack.driver.tick(32);
        assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/f0.jpg")');
        pendingEvidence = true;
        stack.driver.tick(48);
        assert.equal(host.style.getPropertyValue('background-image'), evidence === 'empty' ? 'url("http://localhost/f0.jpg")' : '');
    });
}

test('a playing intro reads a changed CSS resolution cap on its next frame', async () => {
    const frames = Array.from({length: 4}, (_, index) => ({src: 'b' + index + '.jpg', width: 800, height: 800,
        upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 1600}]}));
    const {stack, host} = declaredPage({baseline: null, resolution: true,
        intro: {from: 0, to: 3, durationMs: 4000, easing: 'linear'}, catalogDocument: {frames},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600}});
    stack.driver.tick(100);
    await settleAll(stack.images, 1600, 1600);
    stack.driver.tick(116);
    await settleAll(stack.images, 1600, 1600);
    stack.driver.tick(200);
    assert.equal(presented(host), url('u0.jpg'));
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.driver.tick(1300);
    assert.equal(presented(host), url('u0.jpg'), 'a newly ineligible sharper frame must not paint');
    assert.ok(stack.images.some(image => image.src === url('b1.jpg')));
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(1316);
    assert.equal(presented(host), url('b1.jpg'));
});

test('an optional-resolution cap below the base width still permits that base frame to paint', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true,
        upgrades: [{src: 'sharp.jpg', width: 1600, height: 900}]});
    host.computedStyle = {'--paste-resolution-max-width': '400'};
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('f2.jpg')));
    await settleAll(stack.images, 800, 450);
    stack.driver.tick(32);
    assert.equal(presented(host), url('f2.jpg'));
    assert.equal(stack.images.some(image => image.src === url('sharp.jpg')), false);
});

for (const background of [false, true]) {
    test('a trailing-comma resource remains paintable as a base with background ' + background, async () => {
        const host = new Element(background ? 'div' : 'img', 'host');
        const {stack} = declaredPage({host, baseline: null, imageProperty: background ? 'background-image' : 'src',
            catalogDocument: {frames: [{src: 'base.jpg,', width: 800, height: 450}]}});
        stack.driver.tick(16);
        assert.equal(stack.images.length, 1);
        stack.images[0].succeed(800, 450);
        await settlePromises();
        stack.driver.tick(32);
        assert.equal(background ? host.style.getPropertyValue('background-image') : presented(host),
            background ? 'url("http://localhost/base.jpg,")' : url('base.jpg,'));
    });
}

test('an oversized replacement releases the obsolete decoded image after it paints', async () => {
    require('node:v8').setFlagsFromString('--expose-gc');
    const gc = require('node:vm').runInNewContext('gc');
    const registry = imageRegistry();
    const {stack, scope, host} = declaredPage({baseline: null, scrollscrub: false,
        catalogDocument: {frames: [
            {src: 'large0.jpg', width: 3000, height: 3000},
            {src: 'large1.jpg', width: 3000, height: 3000}
        ]}, window: {Image: registry.Image}});
    stack.driver.tick(16);
    let first = registry.images.find(image => image.src === url('large0.jpg'));
    assert.ok(first);
    const oldImage = new WeakRef(first);
    first.succeed(3000, 3000);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('large0.jpg'));
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(48);
    let second = registry.images.find(image => image.src === url('large1.jpg'));
    assert.ok(second);
    const standingImage = new WeakRef(second);
    second.succeed(3000, 3000);
    await settlePromises();
    stack.driver.tick(64);
    assert.equal(presented(host), url('large1.jpg'));
    first = second = null;
    registry.images.length = 0;
    FakeSubscription.registry = FakeSubscription.registry.filter(subscription => !subscription.disposed);
    for (let round = 0; round < 2; round += 1) {
        await new Promise(resolve => setImmediate(resolve));
        gc();
    }
    assert.equal(oldImage.deref(), undefined, 'the prior decoded image still occupies the cache');
    assert.ok(standingImage.deref(), 'the current presentation must remain retained');
});

// Each case keeps requests in flight across a change of intent. The exact
// admissions protect demand priority, alias accounting and the decoded budget;
// the final source proves that readiness still controls presentation.
const admissionCases = [
    {
        "name": "a retained sharper desired frame funds the buffer before another base request",
        "base": 1000,
        "upgrade": 1400,
        "width": 1400,
        "buffer": 2,
        "resources": [0, 0, 2, 3, 4, 5, 6, 2, 3, 9, 10, 10],
        "actions": [{"scroll": 3}, {"size": 1000}, {"load": "u3.jpg"}],
        "requests": ["u3.jpg", "u4.jpg", "u5.jpg", "u6.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "every cached alias releases its shared resource when a demanded upgrade needs room",
        "base": 1000,
        "upgrade": 1400,
        "width": 1000,
        "buffer": 2,
        "resources": [0, 1, 1, 1, 2, 5, 1, 5, 8, 9, 10, 8],
        "actions": [{"cap": "auto"}, {"size": 1400}, {"load": "b1.jpg"}],
        "requests": ["b0.jpg", "b1.jpg", "b2.jpg", "b5.jpg", "b8.jpg", "u0.jpg", "u1.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "reversing a closed gate releases the old required membership",
        "base": 1000,
        "upgrade": 1400,
        "width": 1400,
        "buffer": 3,
        "resources": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10],
        "actions": [{"cap": 1000}, {"scroll": 5}, {"scroll": 11}, {"load": "b5.jpg"}, {"load": "b3.jpg"}, {"scroll": 10}, {"load": "b9.jpg"}, {"load": "b4.jpg"}],
        "requests": ["b0.jpg", "b1.jpg", "b2.jpg", "b3.jpg", "b4.jpg", "b5.jpg", "b10.jpg", "b9.jpg", "b8.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "a newly open gate permits sharpening its standing frame",
        "base": 1000,
        "upgrade": 1800,
        "width": 1000,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 6, 5, 6, 9, 10, 11],
        "actions": [{"scroll": 4}, {"load": "b11.jpg"}, {"scroll": 9}, {"load": "b9.jpg"}, {"load": "b10.jpg"}, {"size": 1800}, {"load": "u9.jpg"}],
        "requests": ["b4.jpg", "b5.jpg", "b6.jpg", "b9.jpg", "b10.jpg", "b11.jpg", "u9.jpg"],
        "paint": "u9.jpg"
    },
    {
        "name": "required aliases keep their funded resource ahead of optional admissions",
        "base": 1000,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 2,
        "resources": [0, 1, 2, 1, 1, 5, 6, 7, 8, 9, 10, 11],
        "actions": [{"scroll": 3}, {"cap": 1000}, {"scroll": 1}, {"load": "b1.jpg"}],
        "requests": ["u1.jpg", "u5.jpg", "b1.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "resource eviction ranks an alias by its nearest holder",
        "base": 1000,
        "upgrade": 2000,
        "width": 2000,
        "buffer": 4,
        "resources": [0, 0, 2, 0, 2, 5, 6, 1, 0, 9, 10, 11],
        "actions": [{"scroll": 9}, {"scroll": 2}, {"load": "u0.jpg"}, {"load": "u2.jpg"}, {"scroll": 9}, {"size": 1000}, {"load": "b10.jpg"}, {"load": "b11.jpg"}, {"scroll": 0}, {"load": "b0.jpg"}, {"cap": 1000}, {"scroll": 4}],
        "requests": ["u2.jpg", "u0.jpg", "b9.jpg", "b10.jpg", "b11.jpg", "b0.jpg", "b2.jpg", "b5.jpg", "b6.jpg", "b1.jpg", "b10.jpg"],
        "paint": "b0.jpg"
    },
    {
        "name": "the farthest eligible resource is reclaimed before closer cached frames",
        "base": 1000,
        "upgrade": 1600,
        "width": 1600,
        "buffer": 2,
        "resources": [0, 1, 2, 1, 4, 5, 3, 2, 8, 9, 9, 11],
        "actions": [{"cap": 1000}, {"load": "b2.jpg"}, {"load": "b3.jpg"}, {"scroll": 5}, {"scroll": 11}, {"load": "b0.jpg"}, {"scroll": 4}, {"load": "b9.jpg"}],
        "requests": ["b0.jpg", "b1.jpg", "b2.jpg", "b4.jpg", "b5.jpg", "b3.jpg", "b8.jpg", "b9.jpg", "b11.jpg", "b0.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "an admission that still cannot fit leaves reclaimable frames intact",
        "base": 1000,
        "upgrade": 1800,
        "width": 1000,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 6, 5, 6, 9, 10, 11],
        "actions": [{"scroll": 4}, {"load": "b11.jpg"}, {"scroll": 9}, {"load": "b9.jpg"}, {"load": "b10.jpg"}, {"size": 1800}, {"load": "b4.jpg"}, {"scroll": 6}, {"cap": 1000}],
        "requests": ["b4.jpg", "b5.jpg", "b6.jpg", "b9.jpg", "b10.jpg", "b11.jpg", "u9.jpg", "b3.jpg"],
        "paint": "b9.jpg"
    },
    {
        "name": "the proven standing frame remains usable after leaving its prepared slot",
        "base": 1000,
        "upgrade": 2000,
        "width": 2000,
        "buffer": 2,
        "resources": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        "actions": [{"cap": "auto"}, {"scroll": 7}, {"load": "u0.jpg"}, {"cap": 1000}, {"load": "u1.jpg"}, {"load": "b8.jpg"}, {"load": "b7.jpg"}, {"cap": "auto"}, {"scroll": 2}, {"size": 1000}, {"load": "u7.jpg"}, {"scroll": 6}, {"load": "b0.jpg"}],
        "requests": ["u0.jpg", "u1.jpg", "u7.jpg", "b7.jpg", "b8.jpg", "b9.jpg", "b10.jpg", "b2.jpg", "b1.jpg", "b0.jpg", "b6.jpg", "b8.jpg"],
        "paint": "b7.jpg"
    },
    {
        "name": "the standing representation funds its own required alias",
        "base": 1000,
        "upgrade": 1800,
        "width": 1000,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 6, 5, 6, 9, 10, 11],
        "actions": [{"scroll": 4}, {"load": "b11.jpg"}, {"scroll": 9}, {"load": "b9.jpg"}, {"load": "b5.jpg"}, {"load": "b10.jpg"}, {"load": "b4.jpg"}, {"size": 1800}, {"load": "u9.jpg"}, {"scroll": 6}],
        "requests": ["b4.jpg", "b5.jpg", "b6.jpg", "b9.jpg", "b10.jpg", "b11.jpg", "u9.jpg"],
        "paint": "u9.jpg"
    },
    {
        "name": "a narrower late completion cannot replace an eligible sharper cached frame",
        "base": 1000,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 2,
        "resources": [0, 0, 2, 3, 4, 0, 6, 1, 8, 9, 8, 11],
        "actions": [{"cap": "auto"}, {"size": 1000}, {"load": "u0.jpg"}, {"load": "b0.jpg"}],
        "requests": ["u0.jpg", "u2.jpg", "b0.jpg", "b2.jpg"],
        "paint": "u0.jpg"
    },
    {
        "name": "a changed gate reservation is repriced before admitting its members",
        "base": 1000,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 6, 5, 6, 9, 10, 11],
        "actions": [{"scroll": 4}, {"size": 1000}],
        "requests": ["b4.jpg", "b5.jpg", "b6.jpg", "b9.jpg", "b10.jpg", "b11.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "all retained sharper members fund the buffer after a cap change",
        "base": 1000,
        "upgrade": 1400,
        "width": 1400,
        "buffer": 2,
        "resources": [0, 0, 2, 3, 4, 5, 6, 2, 3, 9, 10, 10],
        "actions": [{"scroll": 3}, {"load": "u3.jpg"}, {"size": 1000}, {"scroll": 7}],
        "requests": ["u3.jpg", "u4.jpg", "u5.jpg", "u6.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "eviction prefers obsolete work outside the active window",
        "base": 1000,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 6, 5, 6, 9, 10, 11],
        "actions": [{"scroll": 4}, {"size": 1000}, {"load": "b11.jpg"}, {"scroll": 9}, {"load": "b9.jpg"}, {"load": "b5.jpg"}, {"load": "b10.jpg"}, {"size": 1800}, {"cap": 1000}],
        "requests": ["b4.jpg", "b5.jpg", "b6.jpg", "b9.jpg", "b10.jpg", "b11.jpg", "u9.jpg"],
        "paint": "b9.jpg"
    },
    {
        "name": "required members keep their order when the desired frame already owns an alias",
        "base": 1200,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 4,
        "resources": [0, 1, 2, 3, 4, 5, 4, 7, 8, 8, 10, 11],
        "actions": [{}, {"scroll": 6}, {"size": 1200}],
        "requests": ["b4.jpg", "b7.jpg", "b8.jpg", "b10.jpg", "b11.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "shared sharper funding remains counted until its last alias is replaced",
        "base": 1500,
        "upgrade": 1900,
        "width": 1900,
        "buffer": 4,
        "resources": [0, 1, 1, 0, 4, 5, 6, 0, 8, 9, 10, 11],
        "actions": [{}, {"load": "u1.jpg"}, {"size": 1500}, {"scroll": 1}],
        "requests": ["u0.jpg", "u1.jpg", "b0.jpg", "b4.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "ordinary pending work does not consume the oversized replacement allowance",
        "base": 1800,
        "upgrade": 2400,
        "width": 2400,
        "buffer": 1,
        "resources": [0, 0, 2, 3, 4, 5, 1, 7, 8, 9, 10, 11],
        "actions": [{"cap": 1800}, {"load": "b0.jpg"}, {"scroll": 3}, {"cap": ""}],
        "requests": ["b0.jpg", "b2.jpg", "u3.jpg"],
        "paint": "b0.jpg"
    },
    {
        "name": "an open buffer stays open while its next desired frame is ready",
        "base": 1500,
        "upgrade": 2300,
        "width": 2300,
        "buffer": 3,
        "resources": [0, 1, 2, 3, 1, 5, 6, 7, 8, 5, 10, 2],
        "actions": [{"cap": 1500}, {"scroll": 3}, {"scroll": 2}, {"load": "b0.jpg"}, {"load": "b1.jpg"}, {"load": "b2.jpg"}, {"scroll": 4}],
        "requests": ["b0.jpg", "b1.jpg", "b2.jpg", "b5.jpg"],
        "paint": "b1.jpg"
    },
    {
        "name": "a remembered infeasible buffer keeps optional work from taking its room",
        "base": 1200,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 4,
        "resources": [0, 0, 2, 1, 4, 1, 6, 7, 6, 9, 3, 11],
        "actions": [{"scroll": 9}, {"size": 1200}, {"size": 1800}, {"load": "b3.jpg"}],
        "requests": ["b9.jpg", "b3.jpg", "b11.jpg"],
        "paint": "poster.jpg"
    },
    {
        "name": "an intro protects its desired frame while admitting its lead",
        "base": 1000,
        "upgrade": 1800,
        "width": 1800,
        "buffer": 4,
        "intro": {"from": 0, "to": 11, "durationMs": 3000, "easing": "linear"},
        "stepMs": 100,
        "resources": [0, 1, 2, 3, 4, 0, 6, 7, 8, 9, 1, 1],
        "actions": [{"cap": 1000}, {"load": "b2.jpg"}, {"load": "b1.jpg"}, {"cap": ""}, {"load": "u0.jpg"}, {"load": "b0.jpg"}, {"size": 1800}, {"cap": ""}, {"size": 1000}],
        "requests": ["b0.jpg", "b1.jpg", "b2.jpg", "u0.jpg", "u1.jpg", "b2.jpg", "b3.jpg"],
        "paint": "b1.jpg"
    }
];
for (const sample of admissionCases) {
    test(sample.name, async () => {
        const frames = sample.resources.map(resource => ({src: 'b' + resource + '.jpg', width: sample.base, height: sample.base,
            upgrades: [{src: 'u' + resource + '.jpg', width: sample.upgrade, height: sample.upgrade}]}));
        const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: sample.buffer, intro: sample.intro,
            catalogDocument: {frames}, hostRect: {top: 0, bottom: sample.width, left: 0, right: sample.width,
                width: sample.width, height: sample.width}});
        let at = 0;
        for (const action of sample.actions) {
            if (action.scroll !== undefined) scrollFraction(stack, scope, 800 + (action.scroll + 0.25) / frames.length * 1000);
            if (action.size !== undefined) {
                host.rect.width = host.rect.height = action.size;
                stack.window.fireEvent('resize');
            }
            if (action.cap !== undefined) {
                host.computedStyle = {'--paste-resolution-max-width': String(action.cap)};
                stack.window.fireEvent('resize');
            }
            if (action.load) {
                const image = stack.images.find(image => !image.landed && image.src === url(action.load));
                assert.ok(image, 'the named pending request must exist: ' + action.load);
                image.landed = true;
                const size = action.load.startsWith('u') ? sample.upgrade : sample.base;
                image.succeed(size, size);
                await settlePromises();
            }
            stack.driver.tick(at += sample.stepMs || 16);
        }
        assert.deepEqual(stack.images.map(image => image.src), sample.requests.map(url));
        assert.equal(presented(host), url(sample.paint));
    });
}

test('a sharper cached buffer member is priced in place of its base, not alongside it', async () => {
    const frames = Array.from({length: 6}, (_, index) => ({src: 'b' + index + '.jpg', width: 1000, height: 1000,
        upgrades: index === 4 ? [{src: 'u4.jpg', width: 2200, height: 2200}] : []}));
    const {stack, scope, host} = declaredPage({baseline: null, resolution: true, scrubBuffer: 3,
        catalogDocument: {frames}, hostRect: {top: 0, bottom: 2200, left: 0, right: 2200, width: 2200, height: 2200}});
    let at = 16;
    stack.driver.tick(at);
    for (const index of [0, 1, 2]) {
        const image = stack.images.find(image => image.src === url('b' + index + '.jpg'));
        assert.ok(image);
        image.succeed(1000, 1000);
    }
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('b0.jpg'));
    scrollFraction(stack, scope, 800 + 3.25 / 6 * 1000);
    stack.driver.tick(at += 16);
    const sharp = stack.images.find(image => image.src === url('u4.jpg'));
    assert.ok(sharp, 'the newly required sharper member must be admitted');
    sharp.succeed(2200, 2200);
    await settlePromises();
    stack.driver.tick(at += 16);
    host.rect.width = host.rect.height = 1000;
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    // Standing b0 + required b3/u4/b5 = 31,360,000 bytes, within 32 MiB.
    // Adding b4 again would charge two resources for the same funded member.
    assert.equal(stack.images.some(image => image.src === url('b4.jpg')), false);
    assert.equal(presented(host), url('b0.jpg'), 'the buffer still waits for b3 and b5');
    for (const index of [3, 5]) stack.images.find(image => image.src === url('b' + index + '.jpg')).succeed(1000, 1000);
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('b3.jpg'));
});

test('a tab switch without an intro preserves an already open scrub gate', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, scrubBuffer: 2});
    stack.driver.tick(16);
    for (const index of [0, 1, 2]) stack.images.find(image => image.src === url('f' + index + '.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1100);
    stack.driver.tick(48);
    assert.equal(presented(host), url('f1.jpg'));
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    scrollFraction(stack, scope, 1300);
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(64);
    assert.equal(presented(host), url('f2.jpg'), 'an open gate must not start waiting for the unfinished f3');
});

test('an intro that never revealed its skip does not hide another writer\'s control', () => {
    const {stack, skip} = declaredPage({intro: {durationMs: 3000, skip: '#skip'}, skipId: 'skip'});
    skip.removeAttribute('hidden');
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(16);
    assert.equal(skip.hasAttribute('hidden'), false);
});

test('reduced motion restores a stylesheet poster and returning motion repaints the current frame', async () => {
    const motion = mediaQueryList(), host = new Element('div', 'host');
    host.computedStyle = {'background-image': 'url("http://localhost/poster.jpg")'};
    const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image', catalogDocument: catalog(1),
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/f0.jpg")');
    motion.set(true);
    stack.driver.tick(64);
    assert.equal(host.style.getPropertyValue('background-image'), '');
    stack.driver.tick(80);
    motion.set(false);
    stack.driver.tick(96);
    await settleAll(stack.images);
    stack.driver.tick(112);
    stack.driver.tick(128);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/f0.jpg")');
});

test('an expired waiting intro schedules scroll ownership even without another input', () => {
    const timers = new Map();
    let next = 0;
    const {stack} = declaredPage({baseline: null, sequenceFrom: 3, sequenceTo: 3,
        intro: {from: 0, to: 0, durationMs: 3000}, window: {
            setTimeout(callback, delay) { const id = ++next; timers.set(id, {callback, delay}); return id; },
            clearTimeout(id) { timers.delete(id); }
        }});
    stack.driver.tick(100);
    assert.ok(stack.images.some(image => image.src === url('f0.jpg')));
    assert.equal(stack.images.some(image => image.src === url('f3.jpg')), false);
    assert.equal(stack.driver.pending(), 0);
    const deadline = [...timers.values()].find(timer => timer.delay === 15000);
    assert.ok(deadline);
    deadline.callback();
    assert.equal(stack.driver.pending(), 1);
    stack.driver.tick(15100);
    assert.ok(stack.images.some(image => image.src === url('f3.jpg')));
});

for (const phase of ['opening paint', 'playing paint']) {
    test('a refused ' + phase + ' retires the intro without a self-scheduled retry', async () => {
        const host = new Element('div', 'host');
        const {stack, skip} = declaredPage({host, baseline: null, imageProperty: 'background-image',
            intro: {from: 0, to: 3, durationMs: 4000, easing: 'linear', skip: '#skip'}, skipId: 'skip'});
        stack.driver.tick(100);
        await settleAll(stack.images);
        if (phase === 'playing paint') {
            stack.driver.tick(116);
            await settleAll(stack.images);
            stack.driver.tick(200);
            assert.equal(skip.hasAttribute('hidden'), false);
            assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/f0.jpg")');
        }
        let refused = false;
        const write = host.style.setProperty.bind(host.style);
        host.style.setProperty = (name, value, priority) => {
            if (name === 'background-image' && !refused) { refused = true; throw new Error('paint refused'); }
            write(name, value, priority);
        };
        stack.driver.tick(phase === 'opening paint' ? 116 : 1300);
        assert.equal(refused, true);
        assert.equal(skip.hasAttribute('hidden'), true);
        assert.equal(stack.driver.pending(), 0);
    });
}

test('a refused reduced-motion restoration schedules no automatic retry', async () => {
    const host = new Element('div', 'host'), motion = mediaQueryList();
    const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image', catalogDocument: catalog(1),
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/f0.jpg")');
    let refusals = 0;
    host.style.removeProperty = () => { refusals += 1; throw new Error('restoration refused'); };
    motion.set(true);
    stack.driver.tick(64);
    assert.equal(refusals, 1);
    assert.equal(stack.driver.pending(), 0);
});

test('a background sequence on an img preserves its independent foreground source', async () => {
    const host = new Element('img', 'host');
    host.src = 'foreground.jpg';
    const {stack} = declaredPage({host, baseline: null, imageProperty: 'background-image', catalogDocument: catalog(1)});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('f0.jpg') + '")');
    assert.equal(host.src, url('foreground.jpg'));
    assert.equal(host.getAttribute('srcset'), null);
});

test('a load error while hidden remains failed when the document returns', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, catalogDocument: catalog(2)});
    stack.driver.tick(16);
    const failed = stack.images.find(image => image.src === url('f0.jpg'));
    assert.ok(failed);
    stack.document.hidden = true;
    failed.fail();
    await settlePromises();
    stack.driver.tick(32);
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(48);
    assert.equal(stack.images.filter(image => image.src === url('f0.jpg')).length, 1);
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(64);
    stack.images.find(image => image.src === url('f1.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('f1.jpg'));
});

test('withdrawn resolution attributes no longer belong to the sequence when another writer restores them', async () => {
    const {stack, scope, host} = declaredPage({baseline: null, resolution: true,
        catalogDocument: {frames: [0, 1].map(index => ({src: 'b' + index + '.jpg', width: 800, height: 800,
            upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 1600}]}))},
        hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600}});
    stack.driver.tick(16);
    await settleAll(stack.images, 1600, 1600);
    stack.driver.tick(32);
    const priorSet = host.getAttribute('srcset');
    const priorSizes = host.getAttribute('sizes');
    assert.equal(priorSet, url('u0.jpg') + ' 1600w');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.window.fireEvent('resize');
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(48);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(64);
    assert.equal(host.getAttribute('srcset'), null);
    assert.equal(host.getAttribute('sizes'), null);
    host.setAttribute('srcset', priorSet);
    host.setAttribute('sizes', priorSizes);
    scrollFraction(stack, scope, 800);
    stack.driver.tick(80);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(96);
    assert.equal(host.src, url('b0.jpg'));
    assert.equal(host.getAttribute('srcset'), priorSet);
    assert.equal(host.getAttribute('sizes'), priorSizes);
});

test('a fresh paint after a lapsed claim starts its own verification bound', async function () {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    let fading = false;
    const {stack, scope} = declaredPage({
        host: host,
        baseline: null,
        imageProperty: 'background-image',
        window: {
            getComputedStyle: function (element) {
                return {
                    getPropertyValue: function (name) {
                        const inline = element.style ? element.style.getPropertyValue(name) : '';
                        if (name === 'background-image' && inline && fading) {
                            return 'cross-fade(none 40%, ' + inline + ')';
                        }
                        return inline || '';
                    }
                };
            }
        }
    });
    stack.driver.tick(16);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(32);
    await settleAll(stack.images);
    fading = true;
    stack.driver.tick(48); // the first paint
    stack.driver.tick(64); // its first pending read
    let at = 64;
    while (at < 64 + 5200) {
        stack.driver.tick(at += 16);
    }
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(at += 16);
    await settleAll(stack.images);
    stack.driver.tick(at += 16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'precondition: the second paint was made inside the pending chain');
    const second = at;
    while (at < 64 + 7400) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 1, 'the fresh claim inherited the chain\'s bound');
    while (at < second + 5100 && stack.driver.pending() > 0) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 0, 'the fresh claim outlived its own bound');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('f3.jpg') + '")',
        'a pending claim was reverted');
});

for (const offsetSource of ['nested root', 'document scroller']) {
    test('an intro preserves the initial ' + offsetSource + ' offset', async () => {
        const scroller = new Element('div', 'scroller');
        scroller.clientHeight = offsetSource === 'nested root' ? 400 : 800;
        scroller.scrollHeight = 1600;
        scroller.scrollTop = offsetSource === 'nested root' ? 0 : 100;
        const options = {baseline: null, scrollscrub: false,
            intro: {from: 0, to: 2, durationMs: 3000, easing: 'linear', skip: '#skip'}, skipId: 'skip'};
        if (offsetSource === 'nested root') options.scroller = scroller;
        else { options.document = {scrollingElement: scroller}; options.window = {pageYOffset: 0}; }
        const {stack, skip, host} = declaredPage(options);
        stack.driver.tick(16);
        await settleAll(stack.images);
        stack.driver.tick(32);
        assert.equal(skip.hasAttribute('hidden'), false, 'an unmoved offset must allow the ready intro to start');
        assert.equal(presented(host), url('f0.jpg'));
        stack.driver.tick(1600);
        assert.equal(presented(host), url('f1.jpg'));
    });
}

test('a sequence can explicitly follow a scope outside its ancestor chain', async () => {
    const scope = new Element('div', 'outside');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const host = new Element('img', 'host');
    host.src = 'poster.jpg';
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.setAttribute('data-sequence-scrub', '#outside');
    const frames = scriptJson('frames', catalog(4));
    const stack = openStack({elements: {scope, host, frames}, imagesequence: true, scrollscrub: false});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(presented(host), url('f0.jpg'));
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(48);
    await settleAll(stack.images);
    stack.driver.tick(64);
    assert.equal(presented(host), url('f2.jpg'));
});

test('multiple sharpening scenes share one device-resolution subscription', async () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const hosts = [0, 1].map(index => {
        const host = new Element('img', 'host' + index);
        host.src = 'poster.jpg';
        host.setAttribute('data-paste-imagesequence', '#frames');
        host.setAttribute('data-paste-progressiveresolution', '');
        scope.appendChild(host);
        return host;
    });
    scope.appendChild(scriptJson('frames', catalog(1, [{src: 'sharp.jpg', width: 1600, height: 900}])));
    const queries = [];
    const stack = openStack({elements: {scope}, imagesequence: true, scrollscrub: false,
        window: {matchMedia(query) { queries.push(query); return mediaQueryList(); }}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.deepEqual(hosts.map(presented), [url('f0.jpg'), url('f0.jpg')]);
    assert.equal(queries.filter(query => query.startsWith('(resolution:')).length, 1);
    for (const host of hosts) {
        host.rect.width = 1600;
        host.rect.height = 900;
    }
    stack.resizeObservers.forEach(observer => observer.trigger(scope));
    stack.driver.tick(48);
    const upgrades = stack.images.filter(image => image.src === url('sharp.jpg'));
    assert.equal(upgrades.length, 2, 'the shared scope must invalidate every scene');
    upgrades.forEach(image => image.succeed(1600, 900));
    await settlePromises();
    stack.driver.tick(64);
    assert.deepEqual(hosts.map(presented), [url('sharp.jpg'), url('sharp.jpg')]);
});

for (const background of [false, true]) {
    test('a comma-ending upgrade follows the declared image property with background ' + background, async () => {
        const host = new Element(background ? 'div' : 'img', 'host');
        const {stack} = declaredPage({host, baseline: null, resolution: true,
            imageProperty: background ? 'background-image' : 'src',
            hostRect: {top: 0, bottom: 1600, left: 0, right: 1600, width: 1600, height: 1600},
            catalogDocument: {frames: [{src: 'base.jpg', width: 800, height: 800,
                upgrades: [{src: 'sharp.jpg,', width: 1600, height: 1600}]}]}});
        stack.driver.tick(16);
        assert.deepEqual(stack.images.map(image => image.src), [url(background ? 'sharp.jpg,' : 'base.jpg')]);
        await settleAll(stack.images, background ? 1600 : 800, background ? 1600 : 800);
        stack.driver.tick(32);
        assert.equal(background ? host.style.getPropertyValue('background-image') : presented(host),
            background ? 'url("' + url('sharp.jpg,') + '")' : url('base.jpg'));
    });
}

test('a completion re-evaluates a dead buffer against a CSS cap changed without another input', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: 2,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: [0, 1, 2, 3].map(index => ({src: 'b' + index + '.jpg', width: 800, height: 800,
            upgrades: [{src: 'u' + index + '.jpg', width: 2000, height: 2000}]}))}});
    stack.driver.tick(16);
    for (const index of [0, 1]) stack.images.find(image => image.src === url('b' + index + '.jpg')).succeed(800, 800);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('b0.jpg'));
    host.rect.width = host.rect.height = 2000;
    stack.window.fireEvent('resize');
    scrollFraction(stack, scope, 800 + 1.25 / 4 * 1000);
    stack.driver.tick(48);
    assert.equal(presented(host), url('b0.jpg'), 'the larger required set cannot coexist beside the standing image');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    const pending = stack.images.find(image => image.src === url('b2.jpg'));
    assert.ok(pending);
    pending.succeed(800, 800);
    await settlePromises();
    stack.driver.tick(64);
    assert.equal(presented(host), url('b1.jpg'), 'the now-feasible ready buffer must open on the completion pass');
});

test('a refused decoder probe still adopts an already complete image without a preparation fetch', async () => {
    const registry = imageRegistry();
    let probes = 0;
    function Image() {
        if (++probes === 1) throw new Error('probe refused');
        const image = new registry.Image();
        image.decode = undefined;
        return image;
    }
    const {stack, host, scope} = declaredPage({window: {Image}, catalogDocument: catalog(2)});
    stack.driver.tick(16);
    assert.equal(presented(host), url('f0.jpg'));
    assert.equal(registry.images.some(image => image.src === url('f0.jpg')), false);
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(32);
    const next = registry.images.find(image => image.src === url('f1.jpg'));
    assert.ok(next);
    next.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.equal(presented(host), url('f1.jpg'));
});

test('an expired intro hands off without painting one extra intro frame', async () => {
    const {stack, host, skip} = declaredPage({baseline: null,
        intro: {from: 0, to: 1, durationMs: 1000, easing: 'linear', skip: '#skip'}, skipId: 'skip'});
    stack.driver.tick(0);
    await settleAll(stack.images);
    stack.driver.tick(16);
    assert.equal(presented(host), url('f0.jpg'));
    assert.equal(skip.hasAttribute('hidden'), false);
    stack.driver.tick(1016);
    assert.equal(skip.hasAttribute('hidden'), true);
    assert.equal(presented(host), url('f0.jpg'), 'the expired intro must not paint after retiring');
    stack.driver.tick(1032);
    assert.equal(presented(host), url('f0.jpg'));
});

test('a reverted background claim preserves the last verified pose and its upgrade eligibility', async () => {
    const host = new Element('div', 'host');
    const {stack, scope} = declaredPage({host, baseline: null, resolution: true, imageProperty: 'background-image',
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
        catalogDocument: {frames: [0, 1].map(index => ({src: 'b' + index + '.jpg', width: 800, height: 800,
            upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 1600}]}))}});
    stack.driver.tick(16);
    await settleAll(stack.images, 800, 800);
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('b0.jpg') + '")');
    host.style.setProperty('background-image', 'url("' + url('b0.jpg') + '")', 'important');
    host.computedStyle = {'background-image': 'url("' + url('b0.jpg') + '") !important'};
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(64);
    stack.driver.tick(80);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('b0.jpg') + '")');
    assert.equal(host.style.getPropertyPriority('background-image'), 'important');
    const writes = [];
    const setProperty = host.style.setProperty.bind(host.style);
    host.style.setProperty = (name, value, priority) => { if (name === 'background-image') writes.push(value); setProperty(name, value, priority); };
    host.computedStyle = {};
    scrollFraction(stack, scope, 800);
    stack.driver.tick(96);
    assert.deepEqual(writes, [], 'returning to the restored pose must not restart its CSS transition');
    host.rect.width = host.rect.height = 1600;
    stack.window.fireEvent('resize');
    stack.driver.tick(112);
    const sharp = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(sharp, 'the restored pose must still be eligible to sharpen');
    sharp.succeed(1600, 1600);
    await settlePromises();
    stack.driver.tick(128);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('u0.jpg') + '")');
});

test('a second reduced-motion handoff preserves a source written after the first withdrawal', async () => {
    const motion = mediaQueryList();
    const {stack, host} = declaredPage({baseline: null, window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(presented(host), url('f0.jpg'));
    motion.set(true);
    stack.driver.tick(48);
    stack.driver.tick(64);
    assert.equal(presented(host), url('poster.jpg'));
    host.rect.width = 0;
    motion.set(false);
    stack.driver.tick(80);
    host.src = 'replacement-poster.jpg';
    motion.set(true);
    stack.driver.tick(96);
    assert.equal(presented(host), url('replacement-poster.jpg'));
});

test('an inline authored background still refines when computed style is unavailable', async () => {
    const motion = mediaQueryList();
    motion.matches = true;
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("f0.jpg")');
    const {stack} = declaredPage({host, baseline: null, resolution: true, imageProperty: 'background-image',
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900},
        catalogDocument: catalog(1, [{src: 'sharp.jpg', width: 1600, height: 900}]),
        window: {getComputedStyle: () => null, matchMedia: () => motion}});
    stack.driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('sharp.jpg')));
    await settleAll(stack.images, 1600, 900);
    stack.driver.tick(32);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('sharp.jpg') + '")');
});

test('re-adopting the static baseline honors the CSS cap in the same read phase', async () => {
    const motion = mediaQueryList();
    const host = new Element('div', 'host');
    host.style.setProperty('background-image', 'url("f0.jpg")');
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    const {stack} = declaredPage({host, baseline: null, resolution: true, imageProperty: 'background-image',
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900},
        catalogDocument: catalog(1, [{src: 'sharp.jpg', width: 1600, height: 900}]),
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    motion.set(true);
    stack.driver.tick(48);
    stack.driver.tick(64);
    assert.equal(stack.images.some(image => image.src === url('sharp.jpg')), false);
    host.computedStyle = {'--paste-resolution-max-width': '1600'};
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    const sharp = stack.images.find(image => image.src === url('sharp.jpg'));
    assert.ok(sharp);
    sharp.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(96);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('sharp.jpg') + '")');
});

for (const sample of [{width: 1400, admitted: true}, {width: 2200, admitted: true}, {width: 2800, admitted: false}]) {
    test('a standing upgrade of ' + sample.width + ' pixels is priced once beside a closed required buffer', async () => {
        const {stack, host} = declaredPage({baseline: 'b0.jpg', resolution: true, scrubBuffer: 2,
            hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
            catalogDocument: {frames: [
                {src: 'b0.jpg', width: 1000, height: 1000,
                    upgrades: [{src: 'u0.jpg', width: sample.width, height: sample.width}]},
                {src: 'b1.jpg', width: 1000, height: 1000}
            ]}});
        stack.driver.tick(16);
        stack.images.find(image => image.src === url('b0.jpg')).succeed(1000, 1000);
        stack.images.find(image => image.src === url('b1.jpg')).fail();
        await settlePromises();
        stack.driver.tick(32);
        assert.equal(presented(host), url('b0.jpg'));
        host.rect.width = host.rect.height = sample.width;
        stack.window.fireEvent('resize');
        stack.driver.tick(48);
        const upgrade = stack.images.find(image => image.src === url('u0.jpg'));
        // The feasible reservation counts standing base + candidate + the
        // other member once: 15.84 or 27.36 MB. At 2800, standing + candidate
        // alone cost 35.36 MB and cannot fit the 32 MiB budget.
        assert.equal(!!upgrade, sample.admitted, 'candidate funding must not charge its URL twice or omit the other member');
        if (upgrade) {
            upgrade.succeed(sample.width, sample.width);
            await settlePromises();
            stack.driver.tick(64);
            assert.equal(presented(host), url('u0.jpg'));
        }
    });
}

test('a standing upgrade reserves the other required URL while unrelated work remains in flight', async () => {
    const {stack, host} = declaredPage({baseline: 'b0.jpg', resolution: true, scrubBuffer: 2,
        hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        catalogDocument: {frames: [
            {src: 'b0.jpg', width: 1000, height: 1000, upgrades: [{src: 'u0.jpg', width: 2400, height: 2400}]},
            {src: 'b1.jpg', width: 1000, height: 1000}, {src: 'b2.jpg', width: 1000, height: 1000}
        ]}});
    stack.driver.tick(16);
    const unrelated = stack.images.find(image => image.src === url('b2.jpg'));
    assert.ok(unrelated, 'the optional request must hold its physical slot');
    stack.images.find(image => image.src === url('b0.jpg')).succeed(1000, 1000);
    stack.images.find(image => image.src === url('b1.jpg')).fail();
    await settlePromises();
    stack.driver.tick(32);
    host.rect.width = host.rect.height = 2400;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.equal(stack.images.some(image => image.src === url('u0.jpg')), false,
        'the 4 MB required reservation must stay beside standing, candidate and the in-flight image');
    unrelated.succeed(1000, 1000);
    await settlePromises();
    stack.driver.tick(64);
    const upgrade = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(upgrade, 'settled optional work can be reclaimed to make room');
    upgrade.succeed(2400, 2400);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('u0.jpg'));
});

test('aliased required members reserve one copy of their unfetched URL beside an upgrade', async () => {
    const {stack, host} = declaredPage({baseline: 'b0.jpg', resolution: true, scrubBuffer: 3,
        hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        catalogDocument: {frames: [
            {src: 'b0.jpg', width: 1000, height: 1000, upgrades: [{src: 'u0.jpg', width: 2200, height: 2200}]},
            {src: 'b1.jpg', width: 1000, height: 1000}, {src: 'b1.jpg', width: 1000, height: 1000},
            {src: 'b2.jpg', width: 1000, height: 1000}
        ]}});
    stack.driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('b2.jpg')));
    stack.images.find(image => image.src === url('b0.jpg')).succeed(1000, 1000);
    stack.images.find(image => image.src === url('b1.jpg')).fail();
    await settlePromises();
    stack.driver.tick(32);
    host.rect.width = host.rect.height = 2200;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    const upgrade = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(upgrade, '31.36 MB of distinct URLs fit; duplicating the aliased reservation would refuse');
    upgrade.succeed(2200, 2200);
    await settlePromises();
    stack.driver.tick(64);
    assert.equal(presented(host), url('u0.jpg'));
});

test('retained sharper funding leaves its actual remaining room for smaller lookahead', async () => {
    const frames = Array.from({length: 10}, (_, index) => ({src: 'b' + index + '.jpg',
        width: index === 9 ? 500 : index >= 6 ? 3000 : 1000,
        height: index === 9 ? 500 : index >= 6 ? 3000 : 1000,
        upgrades: index === 4 ? [{src: 'u4.jpg', width: 2200, height: 2200}] :
            index === 9 ? [{src: 'u9.jpg', width: 2000, height: 2000}] : []}));
    const {stack, scope, host} = declaredPage({baseline: null, resolution: true, scrubBuffer: 3,
        catalogDocument: {frames}, hostRect: {top: 0, bottom: 2200, left: 0, right: 2200, width: 2200, height: 2200}});
    let at = 16;
    stack.driver.tick(at);
    for (const index of [0, 1, 2]) {
        const image = stack.images.find(image => image.src === url('b' + index + '.jpg'));
        assert.ok(image);
        image.succeed(1000, 1000);
    }
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('b0.jpg'));
    scrollFraction(stack, scope, 800 + 3.25 / 10 * 1000);
    stack.driver.tick(at += 16);
    const sharp = stack.images.find(image => image.src === url('u4.jpg'));
    assert.ok(sharp, 'the newly required sharper member must be admitted');
    sharp.succeed(2200, 2200);
    await settlePromises();
    stack.driver.tick(at += 16);
    host.rect.width = host.rect.height = 500;
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    // Standing b0 + required b3/u4/b5 = 31,360,000 bytes, within 32 MiB.
    // Adding b4 again would charge two resources for the same funded member.
    assert.equal(stack.images.some(image => image.src === url('b4.jpg')), false);
    assert.ok(stack.images.some(image => image.src === url('b9.jpg')),
        'the small lookahead fits beside actual funding without reserving an unneeded b4');
    assert.equal(presented(host), url('b0.jpg'), 'the buffer still waits for b3 and b5');
    for (const index of [3, 5]) stack.images.find(image => image.src === url('b' + index + '.jpg')).succeed(1000, 1000);
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('b3.jpg'));
});

test('a faulted scene retries on the next pass requested by another scene completion', async () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const hosts = [0, 1].map(index => {
        const host = new Element('div', 'host' + index);
        host.setAttribute('data-paste-imagesequence', '#frames');
        scope.appendChild(host);
        return host;
    });
    scope.appendChild(scriptJson('frames', catalog(1)));
    const stack = openStack({elements: {scope}, imagesequence: true, scrollscrub: false});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 2);
    let attempts = 0;
    const setProperty = hosts[0].style.setProperty.bind(hosts[0].style);
    hosts[0].style.setProperty = (name, value, priority) => {
        if (name === 'background-image' && ++attempts === 1) throw new Error('temporary refusal');
        setProperty(name, value, priority);
    };
    stack.images[0].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(hosts[0].style.getPropertyValue('background-image'), '');
    assert.equal(stack.driver.pending(), 0, 'the fault itself must not schedule a retry');
    stack.images[1].succeed(800, 450);
    await settlePromises();
    stack.driver.tick(48);
    assert.deepEqual(hosts.map(host => host.style.getPropertyValue('background-image')),
        ['url("' + url('f0.jpg') + '")', 'url("' + url('f0.jpg') + '")']);
    assert.equal(attempts, 2);
});

for (const refuses of [false, true]) {
    test('reduced motion retires a playing intro immediately when baseline restoration refuses ' + refuses, async () => {
        const host = new Element('div', 'host'), motion = mediaQueryList();
        const {stack, skip} = declaredPage({host, baseline: null, imageProperty: 'background-image',
            intro: {durationMs: 3000, skip: '#skip'}, skipId: 'skip', window: {matchMedia: () => motion}});
        stack.driver.tick(16);
        await settleAll(stack.images);
        stack.driver.tick(32);
        stack.driver.tick(48);
        assert.equal(skip.hasAttribute('hidden'), false);
        if (refuses) host.style.removeProperty = () => { throw new Error('restoration refused'); };
        motion.set(true);
        stack.driver.tick(64);
        assert.equal(skip.hasAttribute('hidden'), true);
        if (refuses) assert.equal(stack.driver.pending(), 0, 'a failed restoration must not retry itself');
        else {
            assert.equal(host.style.getPropertyValue('background-image'), '');
            stack.driver.tick(80);
            assert.equal(stack.driver.pending(), 0);
        }
    });
}

test('a refused background-claim restoration retires its playing intro without a retry', async () => {
    const host = new Element('div', 'host');
    const {stack, skip} = declaredPage({host, baseline: null, imageProperty: 'background-image',
        intro: {durationMs: 3000, skip: '#skip'}, skipId: 'skip'});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(skip.hasAttribute('hidden'), false);
    host.computedStyle = {'background-image': 'url("foreign.jpg") !important'};
    let refused = 0;
    host.style.removeProperty = () => { refused++; throw new Error('restoration refused'); };
    stack.driver.tick(48);
    assert.equal(refused, 1);
    assert.equal(skip.hasAttribute('hidden'), true);
    assert.equal(stack.driver.pending(), 0);
});

test('two playing intros advance and retire on their own clocks in the shared write pass', async () => {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    scope.rect = {top: 1600, bottom: 1800, width: 100, height: 200};
    const scenes = [1000, 2000].map((duration, index) => {
        const host = new Element('img', 'host' + index), skip = new Element('button', 'skip' + index);
        host.src = 'poster.jpg';
        host.setAttribute('data-paste-imagesequence', '#frames');
        host.setAttribute('data-sequence-intro-duration-ms', String(duration));
        host.setAttribute('data-sequence-intro-easing', 'linear');
        host.setAttribute('data-sequence-intro-skip', '#' + skip.id);
        skip.setAttribute('type', 'button');
        skip.setAttribute('hidden', '');
        scope.appendChild(host);
        scope.appendChild(skip);
        return {host, skip};
    });
    scope.appendChild(scriptJson('frames', catalog(2)));
    const stack = openStack({elements: {scope}, imagesequence: true, scrollscrub: false});
    stack.driver.tick(100);
    await settleAll(stack.images);
    stack.driver.tick(116);
    assert.deepEqual(scenes.map(scene => scene.skip.hasAttribute('hidden')), [false, false]);
    stack.driver.tick(616);
    assert.deepEqual(scenes.map(scene => presented(scene.host)), [url('f1.jpg'), url('f0.jpg')]);
    stack.driver.tick(1216);
    assert.deepEqual(scenes.map(scene => scene.skip.hasAttribute('hidden')), [true, false]);
    assert.equal(presented(scenes[1].host), url('f1.jpg'));
});

test('an intro advances its preparation horizon before the desired frame changes', async () => {
    const {stack, host} = declaredPage({baseline: null, catalogDocument: catalog(100),
        intro: {from: 0, to: 99, durationMs: 9000, easing: 'linear'}});
    stack.driver.tick(0);
    assert.equal(stack.images.some(image => image.src === url('f6.jpg')), false);
    stack.images.find(image => image.src === url('f0.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(16);
    assert.equal(presented(host), url('f0.jpg'));
    stack.driver.tick(66);
    assert.equal(presented(host), url('f0.jpg'));
    assert.ok(stack.images.some(image => image.src === url('f6.jpg')), 'the live horizon must advance within the same displayed frame');
});

test('a ready standing upgrade is priced as the replacement when it frees required-buffer room', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: 3,
        hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        catalogDocument: {frames: [0, 1, 2, 3].map(index => ({src: 'b' + index + '.jpg', width: 1000, height: 1000,
            upgrades: index === 0 ? [{src: 'u0.jpg', width: 2400, height: 2400}] : []}))}});
    stack.driver.tick(16);
    await settleAll(stack.images, 1000, 1000);
    stack.driver.tick(32);
    assert.equal(presented(host), url('b0.jpg'));
    host.rect.width = host.rect.height = 2400;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    const upgrade = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(upgrade);
    const originalRect = scope.rect;
    scope.clientRects = [];
    scope.rect = {top: 0, bottom: 0, width: 0, height: 0};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    scope.clientRects = undefined;
    scope.rect = originalRect;
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    assert.equal(presented(host), url('b0.jpg'));
    upgrade.succeed(2400, 2400);
    await settlePromises();
    stack.driver.tick(96);
    assert.equal(presented(host), url('u0.jpg'), 'the standing replacement and its required set fit in 31.04 MB');
    stack.driver.tick(112);
    assert.ok(stack.images.filter(image => image.src === url('b2.jpg')).length >= 2,
        'the freed capacity must let the evicted required member return');
});

test('equal-distance obsolete images evict behind the direction of travel first', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true,
        hostRect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        catalogDocument: {frames: Array.from({length: 21}, (_, index) => ({src: 'b' + index + '.jpg',
            width: [0, 10, 20].includes(index) ? 1000 : 3000,
            height: [0, 10, 20].includes(index) ? 1000 : 3000,
            upgrades: index === 10 ? [{src: 'u10.jpg', width: 2400, height: 2400}] : []}))}});
    let at = 0;
    for (const index of [0, 20, 10]) {
        scrollFraction(stack, scope, 800 + (index + 0.25) / 21 * 1000);
        stack.driver.tick(at += 16);
        const image = stack.images.find(image => image.src === url('b' + index + '.jpg'));
        assert.ok(image);
        image.succeed(1000, 1000);
        await settlePromises();
        stack.driver.tick(at += 16);
        assert.equal(presented(host), url('b' + index + '.jpg'));
    }
    host.rect.width = host.rect.height = 2400;
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    const upgrade = stack.images.find(image => image.src === url('u10.jpg'));
    assert.ok(upgrade);
    upgrade.succeed(2400, 2400);
    await settlePromises();
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('u10.jpg'));
    scrollFraction(stack, scope, 800 + 0.25 / 21 * 1000);
    stack.driver.tick(at += 16);
    assert.equal(presented(host), url('b0.jpg'), 'the equidistant image ahead must remain available');
    assert.equal(stack.images.filter(image => image.src === url('b0.jpg')).length, 1);
});

test('leaving and returning keeps ready aliases of the standing resource without refetching', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, catalogDocument: {frames: [
        {src: 'same.jpg', width: 800, height: 450}, {src: 'same.jpg', width: 800, height: 450},
        {src: 'other.jpg', width: 800, height: 450}
    ]}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    assert.equal(presented(host), url('same.jpg'));
    scrollFraction(stack, scope, 9000);
    stack.driver.tick(48);
    scrollFraction(stack, scope, 1300);
    stack.driver.tick(64);
    assert.equal(presented(host), url('same.jpg'));
    assert.equal(stack.images.filter(image => image.src === url('same.jpg')).length, 1);
});



test('a reverted oversized background preserves proof of the old standing source after its cache was reclaimed', async () => {
    const host = new Element('div', 'host');
    const {stack, scope} = declaredPage({host, baseline: null, imageProperty: 'background-image',
        catalogDocument: {frames: [0, 1].map(index => ({src: 'b' + index + '.jpg', width: index === 0 ? 1800 : 3000, height: index === 0 ? 1800 : 3000}))}});
    stack.driver.tick(16);
    stack.images.find(image => image.src === url('b0.jpg')).succeed(1800, 1800);
    await settlePromises();
    stack.driver.tick(32);
    stack.driver.tick(48);
    host.computedStyle = {'background-image': 'url("foreign.jpg") !important'};
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(64);
    stack.images.find(image => image.src === url('b1.jpg')).succeed(3000, 3000);
    await settlePromises();
    stack.driver.tick(80);
    stack.driver.tick(96);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('b0.jpg') + '")');
    host.computedStyle = {};
    scrollFraction(stack, scope, 800);
    stack.driver.tick(112);
    assert.equal(stack.images.filter(image => image.src === url('b0.jpg')).length, 1,
        'restoring a verified source must not lose its readiness when the old cache entry was evicted');
});

for (const initialWidth of [1000, 3000]) {
    test('a static authored proof of ' + initialWidth + ' pixels uses only its own admission allowance', async () => {
        const motion = mediaQueryList();
        motion.matches = true;
        const {stack, host, scope} = declaredPage({baseline: 'b0.jpg', resolution: true,
            window: {matchMedia: () => motion}, catalogDocument: {frames: [
                {src: 'b0.jpg', width: initialWidth, height: initialWidth},
                {src: 'b1.jpg', width: 3000, height: 3000}
            ]}});
        stack.driver.tick(16);
        const proof = stack.images.find(image => image.src === url('b0.jpg'));
        assert.ok(proof, 'the authored frame must receive its preparation proof');
        assert.equal(presented(host), url('b0.jpg'));
        motion.set(false);
        scrollFraction(stack, scope, 1600);
        stack.driver.tick(32);
        assert.equal(stack.images.some(image => image.src === url('b1.jpg')), initialWidth === 1000,
            'ordinary proof does not occupy the oversized allowance; oversized proof does');
        proof.succeed(initialWidth, initialWidth);
        await settlePromises();
        stack.driver.tick(48);
        const next = stack.images.find(image => image.src === url('b1.jpg'));
        assert.ok(next);
        next.succeed(3000, 3000);
        await settlePromises();
        stack.driver.tick(64);
        assert.equal(presented(host), url('b1.jpg'));
    });
}

test('a pending optional static upgrade does not consume the mandatory oversized allowance', async () => {
    const motion = mediaQueryList();
    motion.matches = true;
    const {stack, host, scope} = declaredPage({baseline: 'b0.jpg', resolution: true,
        hostRect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500},
        window: {matchMedia: () => motion}, catalogDocument: {frames: [
            {src: 'b0.jpg', width: 1000, height: 1000, upgrades: [{src: 'u0.jpg', width: 1500, height: 1500}]},
            {src: 'b1.jpg', width: 3000, height: 3000}
        ]}});
    stack.driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('u0.jpg')));
    motion.set(false);
    scrollFraction(stack, scope, 1600);
    stack.driver.tick(32);
    const next = stack.images.find(image => image.src === url('b1.jpg'));
    assert.ok(next, 'ordinary optional work must not hold the mandatory exception');
    next.succeed(3000, 3000);
    await settlePromises();
    stack.driver.tick(48);
    assert.equal(presented(host), url('b1.jpg'));
});

test('a refused mandatory desire prevents smaller lookahead from spending the remaining room', async () => {
    const frames = Array.from({length: 12}, (_, index) => ({
        src: index >= 1 && index <= 8 ? 'held.jpg' : 'b' + index + '.jpg',
        width: index === 0 ? 1000 : index === 11 ? 500 : 2000,
        height: index === 0 ? 1000 : index === 11 ? 500 : 2000
    }));
    const {stack, host, scope} = declaredPage({baseline: null, catalogDocument: {frames}});
    stack.driver.tick(16);
    stack.images.find(image => image.src === url('b0.jpg')).succeed(1000, 1000);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('b0.jpg'));
    const held = stack.images.find(image => image.src === url('held.jpg'));
    assert.ok(held);
    scrollFraction(stack, scope, 800 + 10.25 / 12 * 1000);
    stack.driver.tick(48);
    assert.equal(stack.images.some(image => image.src === url('b10.jpg')), false);
    assert.equal(stack.images.some(image => image.src === url('b11.jpg')), false,
        'optional work must not jump ahead of the refused demand');
    held.succeed(2000, 2000);
    await settlePromises();
    stack.driver.tick(64);
    const desired = stack.images.find(image => image.src === url('b10.jpg'));
    assert.ok(desired, 'the settled obsolete aliases can now make room for demand');
    desired.succeed(2000, 2000);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('b10.jpg'));
});

test('leaving the band releases prepared image objects while keeping the standing URL', async () => {
    require('node:v8').setFlagsFromString('--expose-gc');
    const gc = require('node:vm').runInNewContext('gc');
    const registry = imageRegistry();
    const {stack, scope, host} = declaredPage({baseline: null, scrollscrub: false, window: {Image: registry.Image},
        catalogDocument: {frames: [0, 1].map(() => ({src: 'same.jpg', width: 800, height: 450}))}});
    stack.driver.tick(16);
    let prepared = registry.images.find(image => image.src === url('same.jpg'));
    assert.ok(prepared);
    const reference = new WeakRef(prepared);
    prepared.succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('same.jpg'));
    prepared = null;
    registry.images.length = 0;
    FakeSubscription.registry = FakeSubscription.registry.filter(subscription => !subscription.disposed);
    for (let round = 0; round < 2; round++) {
        await new Promise(resolve => setImmediate(resolve));
        gc();
    }
    assert.ok(reference.deref(), 'an active scene must retain its decoded preparation');
    scrollFraction(stack, scope, 9000);
    stack.driver.tick(48);
    for (let round = 0; round < 2; round++) {
        await new Promise(resolve => setImmediate(resolve));
        gc();
    }
    assert.equal(reference.deref(), undefined, 'alias entries must not retain decoded preparation objects while away');
    assert.equal(presented(host), url('same.jpg'));
    scrollFraction(stack, scope, 800);
    stack.driver.tick(64);
    assert.equal(presented(host), url('same.jpg'));
    assert.equal(registry.images.length, 0, 'returning must reuse the retained readiness');
});

test('a playing intro samples its CSS cap on an otherwise idle clock tick', async () => {
    const {stack, host} = declaredPage({resolution: true,
        hostRect: {top: 0, bottom: 900, left: 0, right: 1600, width: 1600, height: 900},
        catalogDocument: {frames: [{src: 'f0.jpg', width: 800, height: 450,
            upgrades: [{src: 'u0.jpg', width: 1600, height: 900}]}]},
        intro: {from: 0, to: 0, durationMs: 1000}});
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    stack.driver.tick(48);
    assert.equal(presented(host), url('f0.jpg'));
    assert.equal(stack.images.some(image => image.src === url('u0.jpg')), false);
    host.computedStyle = {'--paste-resolution-max-width': '1600'};
    stack.driver.tick(64);
    const upgrade = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(upgrade, 'a live intro must observe current CSS without another input');
    upgrade.succeed(1600, 900);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('u0.jpg'));
});

test('an expired intro wait retires when completion arrives before its timer callback', async () => {
    const {stack, host, skip} = declaredPage({baseline: null, skipId: 'skip',
        intro: {from: 0, to: 3, durationMs: 1000, bufferMs: 1000, skip: '#skip'},
        window: {setTimeout: () => 1, clearTimeout: () => {}}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(15017);
    assert.equal(skip.hasAttribute('hidden'), true, 'late pixels must not start an expired intro');
    assert.equal(presented(host), url('f0.jpg'));
    stack.driver.tick(16017);
    assert.equal(presented(host), url('f0.jpg'));
});

test('a hidden host closes its buffer gate before returning to a ready neighbor', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, scrubBuffer: 2});
    stack.driver.tick(16);
    for (const index of [0, 1]) stack.images.find(image => image.src === url('f' + index + '.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('f0.jpg'));
    const rect = host.rect;
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    host.rect = rect;
    scrollFraction(stack, scope, 1100);
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.equal(presented(host), url('f0.jpg'), 'returning to frame one must wait for its required frame two');
    stack.images.find(image => image.src === url('f2.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('f1.jpg'));
});

test('a restored static baseline keeps its decode proof across later passes', async () => {
    const motion = mediaQueryList();
    const {stack, host} = declaredPage({baseline: 'f0.jpg', resolution: true,
        window: {matchMedia: () => motion}});
    stack.driver.tick(16);
    await settleAll(stack.images);
    stack.driver.tick(32);
    motion.set(true);
    stack.driver.tick(48);
    stack.driver.tick(64);
    await settleAll(stack.images);
    stack.driver.tick(80);
    const count = stack.images.filter(image => image.src === url('f0.jpg')).length;
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.equal(stack.images.filter(image => image.src === url('f0.jpg')).length, count,
        'a later pass must not re-adopt a proven source as unproven');
    assert.equal(presented(host), url('f0.jpg'));
});

test('returning from a hidden host starts lookahead in the declared direction', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, scrubBuffer: 2});
    scrollFraction(stack, scope, 1800);
    stack.driver.tick(16);
    stack.images.find(image => image.src === url('f3.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 1400);
    stack.driver.tick(48);
    for (const index of [1, 2]) stack.images.find(image => image.src === url('f' + index + '.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(64);
    assert.equal(presented(host), url('f2.jpg'));
    const rect = host.rect;
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.window.fireEvent('resize');
    stack.driver.tick(80);
    host.rect = rect;
    scrollFraction(stack, scope, 1100);
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.equal(presented(host), url('f1.jpg'), 'the fresh forward buffer is ready without frame zero');
});

for (const capAfterRefusal of [800, 1600]) {
    test('a refused standing background upgrade respects subsequent CSS cap ' + capAfterRefusal, async () => {
        const host = new Element('div', 'host');
        const {stack} = declaredPage({host, baseline: null, resolution: true, imageProperty: 'background-image',
            hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800},
            catalogDocument: {frames: [{src: 'base.jpg', width: 800, height: 800,
                upgrades: [{src: 'sharp.jpg', width: 1600, height: 1600}]}]}});
        stack.driver.tick(16);
        await settleAll(stack.images, 800, 800);
        stack.driver.tick(32);
        stack.driver.tick(48);
        host.computedStyle = {'background-image': 'url("foreign.jpg") !important'};
        host.rect.width = host.rect.height = 1600;
        stack.window.fireEvent('resize');
        stack.driver.tick(64);
        const sharp = stack.images.find(image => image.src === url('sharp.jpg'));
        assert.ok(sharp);
        sharp.succeed(1600, 1600);
        await settlePromises();
        stack.driver.tick(80);
        stack.driver.tick(96);
        stack.driver.tick(112);
        assert.equal(host.style.getPropertyValue('background-image'), 'url("' + url('base.jpg') + '")',
            'a refused claim must not immediately rewrite the same upgrade');
        host.computedStyle = {'--paste-resolution-max-width': String(capAfterRefusal)};
        stack.window.fireEvent('resize');
        stack.driver.tick(128);
        assert.equal(host.style.getPropertyValue('background-image'),
            'url("' + url(capAfterRefusal === 800 ? 'base.jpg' : 'sharp.jpg') + '")');
    });
}

test('a standing upgrade takes a freed physical slot before more lookahead', async () => {
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true,
        hostRect: {top: 0, bottom: 450, left: 0, right: 800, width: 800, height: 450},
        catalogDocument: {frames: Array.from({length: 12}, (_, index) => ({src: 'b' + index + '.jpg',
            width: 800, height: 450, upgrades: [{src: 'u' + index + '.jpg', width: 1600, height: 900}]}))}});
    stack.driver.tick(16);
    for (const index of [0, 4]) stack.images.find(image => image.src === url('b' + index + '.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(32);
    scrollFraction(stack, scope, 800 + 4.25 / 12 * 1000);
    stack.driver.tick(48);
    assert.equal(presented(host), url('b4.jpg'));
    host.rect.width = 1600;
    host.rect.height = 900;
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.equal(stack.images.some(image => image.src === url('u4.jpg')), false);
    stack.images.find(image => image.src === url('b1.jpg')).succeed(800, 450);
    await settlePromises();
    stack.driver.tick(80);
    assert.ok(stack.images.some(image => image.src === url('u4.jpg')), 'sharpening the standing frame outranks further speculation');
    assert.equal(stack.images.some(image => image.src === url('b8.jpg')), false);
});

test('rejecting one retained tier still funds a later affordable tier in the same buffer', async () => {
    const frames = [
        {src: 'b0.jpg', width: 500, height: 500, upgrades: [{src: 'u0.jpg', width: 2500, height: 2500}]},
        {src: 'b1.jpg', width: 500, height: 500, upgrades: [{src: 'u1.jpg', width: 800, height: 800}]},
        {src: 'b2.jpg', width: 1800, height: 1800},
        ...[3, 4, 5].map(index => ({src: 'b' + index + '.jpg', width: 200, height: 200}))
    ];
    const {stack, host, scope} = declaredPage({baseline: null, resolution: true, scrubBuffer: 3,
        hostRect: {top: 0, bottom: 800, left: 0, right: 800, width: 800, height: 800}, catalogDocument: {frames}});
    host.computedStyle = {'--paste-resolution-max-width': '800'};
    scrollFraction(stack, scope, 800 + 1.25 / 6 * 1000);
    stack.driver.tick(16);
    for (const image of stack.images) {
        const rep = frames.flatMap(frame => [frame, ...(frame.upgrades || [])]).find(rep => url(rep.src) === image.src);
        if (rep) image.succeed(rep.width, rep.height);
    }
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(presented(host), url('u1.jpg'));
    host.rect.width = host.rect.height = 500;
    scrollFraction(stack, scope, 800);
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    stack.images.find(image => image.src === url('b0.jpg')).succeed(500, 500);
    await settlePromises();
    stack.driver.tick(56);
    assert.equal(presented(host), url('b0.jpg'));
    host.rect.width = host.rect.height = 2500;
    host.computedStyle = {};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    const large = stack.images.find(image => image.src === url('u0.jpg'));
    assert.ok(large);
    large.succeed(2500, 2500);
    await settlePromises();
    stack.driver.tick(80);
    assert.equal(presented(host), url('u0.jpg'));
    host.rect.width = host.rect.height = 500;
    scrollFraction(stack, scope, 1800);
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    const last = stack.images.filter(image => image.src === url('b5.jpg')).at(-1);
    last.succeed(200, 200);
    await settlePromises();
    stack.driver.tick(112);
    assert.equal(presented(host), url('b5.jpg'));
    const visibleRect = host.rect;
    host.rect = {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0};
    stack.window.fireEvent('resize');
    stack.driver.tick(120);
    host.rect = visibleRect;
    scrollFraction(stack, scope, 800);
    stack.window.fireEvent('resize');
    stack.driver.tick(128);
    const required = stack.images.filter(image => image.src === url('b2.jpg')).at(-1);
    required.succeed(1800, 1800);
    await settlePromises();
    stack.driver.tick(144);
    assert.equal(stack.images.some(image => image.src === url('b1.jpg')), false,
        'the affordable retained tier must stay funded after the earlier retained tier was rejected');
});

// A host that refuses the frame makes requestPhased throw. The refused
// request armed nothing, so the pending flag must not outlive it: the
// next input asks again and its pass requests the frame it wants.
test('a refused frame request leaves the next input free to ask again', () => {
    FakeSubscription.reset();
    const driver = require('./fakes.cjs').frameDriver();
    const requestPhased = driver.requestPhased;
    let refusals = 1;
    let calls = 0;
    driver.requestPhased = function (read, write) {
        calls += 1;
        if (refusals > 0) {
            refusals -= 1;
            throw new Error('frame refused');
        }
        return requestPhased(read, write);
    };
    const {stack, scope} = declaredPage({scrollscrub: false, frameDriver: driver});
    assert.strictEqual(calls, 1, 'the bind asked for its first pass');
    scrollFraction(stack, scope, 1300);
    assert.strictEqual(calls, 2, 'the input after a refused request did not ask again');
    driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('f2.jpg')),
        'the pass after a refused request never ran');
});

// A refusal that still queued its pair: when a frame delivers that pair
// with no request after it, the pass still runs.
test('a pair a refused request still queued runs its pass when delivered', () => {
    FakeSubscription.reset();
    const driver = require('./fakes.cjs').frameDriver();
    const requestPhased = driver.requestPhased;
    let refusals = 1;
    driver.requestPhased = function (read, write) {
        requestPhased(read, write);
        if (refusals > 0) {
            refusals -= 1;
            throw new Error('frame refused after queueing');
        }
    };
    const {stack} = declaredPage({baseline: null, scrollscrub: false, frameDriver: driver});
    driver.tick(16);
    assert.ok(stack.images.some(image => image.src === url('f0.jpg')),
        'the queued pass did not run');
});
