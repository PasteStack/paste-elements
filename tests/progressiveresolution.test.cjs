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

'use strict';

// The progressiveresolution element contract: a declared host keeps its
// authored image until a sharper representation is genuinely worth it —
// need is painted size times device pixel ratio, the CSS custom property
// caps optional upgrades only, and the commit gate never lets a worse
// or ineligible completion replace what is displayed.

const test = require('node:test');
const assert = require('assert/strict');
const fakes = require('./fakes.cjs');
const {Element, FakeSubscription, settlePromises, imageRegistry, mediaQueryList} = fakes;

// Core publishes the subscription constructor as event['Event']['Subscription']
// and honors its executeCount argument; this suite's double does both —
// a FakeSubscription that also records the count it was given, reachable
// where core puts it.
class CountingSubscription extends FakeSubscription {
    constructor(name, target, method, context, executeCount) {
        super(name, target, method);
        this.executeCount = executeCount || 0;
    }
}
fakes.eventModule.Event.Subscription = CountingSubscription;

// A browser's Image is an element: core's Subscription binds load and
// error on it only because it carries a nodeType. The suite's images are
// the shared registry's, given that nodeType; stack.images lists them.
//
// The module reports a malformed declaration by rethrowing a TypeError
// from a timer it captures at define. The suite's timer runs each
// callback at once and keeps what it throws as stack.reported, so a
// report is an assertion, never an uncaught error in the test process.
function openStack(env) {
    env = env || {};
    const registry = imageRegistry();
    const reported = [];
    const window = Object.assign({
        Image: function () {
            const image = registry.Image();
            image.nodeType = 1;
            return image;
        },
        setTimeout: function (callback) {
            try {
                callback();
            } catch (error) {
                reported.push(error);
            }
            return reported.length;
        }
    }, env.window || {});
    const stack = fakes.openUiStack(Object.assign({}, env, {window: window}));
    stack.images = registry.images;
    stack.reported = reported;
    return stack;
}

// What an img host displays: the module writes its upgrade as a srcset
// width descriptor beside the authored src, so the srcset's one
// candidate URL is the displayed source when present.
function shown(img) {
    const srcset = img.getAttribute('srcset');
    return srcset === null ? img.src : srcset.split(' ')[0];
}

// Prepared and painted sources surface resolved against the fake
// document's base — the same shape a browser's src getter reports.
const url = function (src) { return 'http://localhost/' + src; };

function scriptJson(id, object) {
    const script = new Element('script', id);
    script.setAttribute('type', 'application/json');
    script.textContent = JSON.stringify(object);
    return script;
}

function descriptorDocument(width, upgrades) {
    return {
        src: 'base-' + width + '.jpg',
        width: width,
        height: width,
        upgrades: upgrades || []
    };
}

// A browser reflects an img's src property to its attribute: a script
// writing img.src writes the attribute the module's ownership reads.
// The getter answers the attribute text as written.
function reflectSrc(element) {
    Object.defineProperty(element, 'src', {
        configurable: true,
        get: function () {
            const value = element.getAttribute('src');
            return value === null ? '' : value;
        },
        set: function (value) {
            element.setAttribute('src', value);
        }
    });
    return element;
}

function standaloneHost(env) {
    env = env || {};
    const host = env.host || new Element('img', 'host');
    if ((host.tagName || '').toUpperCase() === 'IMG' && !env.unreflected) {
        reflectSrc(host);
    }
    host.src = env.hostSrc === undefined ? 'base-640.jpg' : env.hostSrc;
    // Fixture hosts are layout-defined by default: authored width and
    // height pin the box so a plain src replacement preserves sizing —
    // the srcset density path is the unsized case and opts in explicitly.
    if (!env.unsized && (host.tagName || '').toUpperCase() === 'IMG') {
        host.setAttribute('width', env.sizedWidth === undefined ? '640' : env.sizedWidth);
        host.setAttribute('height', env.sizedHeight === undefined ? '640' : env.sizedHeight);
    }
    host.setAttribute('data-paste-progressiveresolution', '');
    host.setAttribute('data-image-sources', '#desc');
    if (env.imageProperty) {
        host.setAttribute('data-image-property', env.imageProperty);
    }
    Object.keys(env.elementAttributes || {}).forEach(function (name) {
        host.setAttribute(name, env.elementAttributes[name]);
    });
    host.rect = env.rect || {top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600};
    host.computedStyle = env.computedStyle || {};
    const desc = scriptJson('desc', env.descriptor === undefined ?
        descriptorDocument(640, [
            {src: 'up-1280.jpg', width: 1280, height: 1280},
            {src: 'up-1920.jpg', width: 1920, height: 1920}
        ]) : env.descriptor);
    const elements = {host: host, desc: desc};
    if (env.parent) {
        env.parent.appendChild(host);
        elements.parent = env.parent;
    }
    Object.keys(env.elements || {}).forEach(function (name) {
        elements[name] = env.elements[name];
    });
    const stack = openStack({
        elements: elements,
        scrollscrub: false,
        progressiveresolution: true,
        window: env.window,
        document: env.document,
        globals: env.globals,
        frameDriver: env.frameDriver,
        beforeElements: env.beforeElements
    });
    return {stack: stack, host: host, desc: desc};
}

function sufficientBaseFetchesNothing() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 500, left: 0, right: 500, width: 500, height: 500}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'the base already covers the painted need');
    assert.strictEqual(shown(host), 'base-640.jpg');
}

async function needSelectsSmallestSufficientUpgrade() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'one upgrade prepares');
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'), 'the smallest sufficient representation');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'), 'the sharper image commits');
}

function capRestrictsButNeverBlocksTheBase() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1500, width: 1500, height: 700},
        computedStyle: {'--paste-resolution-max-width': '1000'}
    });
    stack.driver.tick(16);
    // The cap filters both upgrades; the base is still the displayed
    // content — nothing blocked, nothing fetched.
    assert.strictEqual(stack.images.length, 0, 'capped upgrades are skipped');
    assert.strictEqual(shown(host), 'base-640.jpg', 'the baseline stands under any cap');
}

async function largerCapChoosesTheLargestEligible() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1500, width: 1500, height: 700},
        computedStyle: {'--paste-resolution-max-width': '1300'}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'), '1920 exceeds the cap');
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'));
}

async function capDropMidFlightRefusesTheCommit() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    // The media query falls before the fetch lands: the pending work is
    // withdrawn and nothing worse-than-policy commits.
    host.computedStyle = {'--paste-resolution-max-width': '700'};
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), 'base-640.jpg', 'a now-ineligible completion never paints');
}

async function neverDowngradeOnShrink() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    // The box shrinks; the displayed image does not regress.
    host.rect = {top: 0, bottom: 300, left: 0, right: 300, width: 300, height: 300};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'), 'a smaller need never replaces the better image');
    assert.strictEqual(stack.images.length, 1, 'no pointless refetch');
}

async function resizeRereadsPolicyWithoutGeometryChange() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    // Same box, same cap — only the device pixel ratio changed: the
    // need doubles and a still-sharper tier becomes worthwhile.
    stack.window.devicePixelRatio = 2;
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 2, 'the reread picks up the dpr change');
    assert.strictEqual(stack.images[1].src, url('up-1920.jpg'));
    stack.images[1].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1920.jpg'));
}

async function containerQueryPolicyIsObserved() {
    FakeSubscription.reset();
    // The policy lives on an ancestor size container and inherits; only
    // that container's geometry can move the value while the host's
    // own box stays put.
    const container = new Element('div', 'container');
    container.computedStyle = {'container-type': 'inline-size', '--paste-resolution-max-width': '700'};
    const {stack, host} = standaloneHost({
        parent: container,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'the inherited cap suppresses the upgrade');
    const containerObserver = stack.resizeObservers.filter(function (observer) {
        return observer.observed.indexOf(container) >= 0;
    })[0];
    assert.ok(containerObserver, 'the size container is watched');

    container.computedStyle['--paste-resolution-max-width'] = '2000';
    containerObserver.trigger();
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1, 'the container policy change is seen');
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'));
}

function sequenceOwnedHostsAreSkipped() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'base-640.jpg';
    host.setAttribute('data-paste-progressiveresolution', '');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.setAttribute('data-image-sources', '#desc');
    const desc = scriptJson('desc', descriptorDocument(640, [{src: 'up-1280.jpg', width: 1280, height: 1280}]));
    const stack = openStack({
        elements: {host: host, desc: desc},
        scrollscrub: false,
        progressiveresolution: true
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'the sequence owner is the only source writer');
    assert.strictEqual(shown(host), 'http://localhost/base-640.jpg');
}

function nativeSrcsetHostsAreSkipped() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        elementAttributes: {srcset: 'base-640.jpg 1x, base-1280.jpg 2x'}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'native srcset keeps its authority');
}

function missingDescriptorStaysInert() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.src = 'poster.jpg';
    host.setAttribute('data-paste-progressiveresolution', '');
    const stack = openStack({
        elements: {host: host},
        scrollscrub: false,
        progressiveresolution: true
    });
    stack.driver.tick(16);
    assert.strictEqual(shown(host), 'http://localhost/poster.jpg');
    assert.strictEqual(stack.images.length, 0);
}

// A descriptor body that is not JSON is a malformed declaration like
// any other: the parse throw is contained to that host — authored src
// stands, nothing is fetched — while a sound neighbor upgrades through
// the same scan.
async function malformedDescriptorJsonStaysInert() {
    FakeSubscription.reset();
    const bad = new Element('img', 'bad');
    bad.src = 'poster.jpg';
    bad.setAttribute('data-paste-progressiveresolution', '');
    bad.setAttribute('data-image-sources', '#broken');
    bad.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const broken = new Element('script', 'broken');
    broken.setAttribute('type', 'application/json');
    broken.textContent = '{not json';
    const {stack, host: good} = standaloneHost({
        elements: {bad: bad, broken: broken},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(shown(bad), 'http://localhost/poster.jpg',
        'unparseable JSON leaves the authored baseline');
    assert.strictEqual(stack.images.length, 1,
        'only the sound descriptor fetched');
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(good), url('up-1280.jpg'),
        'the malformed descriptor never interrupted the sound host');
}

async function failedUpgradeKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].fail();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), 'base-640.jpg', 'a failed upgrade never erases the baseline');
}

// Failure memory is per source, never against the ladder: the
// preferred 1920 rung dies, and the best surviving improvement at or
// below it — the healthy 1280 tier — starts on the settlement-driven
// reevaluation, commits after its own decode, and the dead 1920 is
// never retried.
async function failedTopRungFallsToTheSurvivingRung() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the preferred rung prepares');
    assert.strictEqual(stack.images[0].src, url('up-1920.jpg'));
    stack.images[0].fail();
    await settlePromises();
    stack.driver.tick(32); // the parked failure reconciles on the next pass
    assert.strictEqual(stack.images.length, 2,
        'the dead preferred rung leaves the best surviving improvement');
    assert.strictEqual(stack.images[1].src, url('up-1280.jpg'));
    stack.images[1].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the surviving rung commits after its decode');
    stack.driver.tick(64);
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('up-1920.jpg');
    }).length, 1, 'the failed preferred rung is never retried');
}

// Every improving rung dead leaves the authored baseline intact — the
// ladder's memory prevents further churn but nothing manufactures an
// improvement that failed.
async function everyImprovingRungFailedKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].fail(); // the 1920 preferred rung dies
    await settlePromises();
    stack.driver.tick(32);
    stack.images[1].fail(); // the 1280 fallback dies too
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 2,
        'no further fetch — every improving rung is dead');
    assert.strictEqual(shown(host), 'base-640.jpg', 'the baseline stands');
}

// Descriptor srcs are authored against the document's base — the
// page's location resolves them, never the module's bundle location.
// Absolute URLs keep their origin; relatives resolve with query intact.
function relativeSourcesResolveAgainstTheDocumentBase() {
    FakeSubscription.reset();
    // Need 1500: the relative 1920 is the smallest sufficient — it
    // resolves against the document base, query intact.
    const first = standaloneHost({
        document: {baseURI: 'http://localhost/pages/guide/'},
        hostSrc: 'base-640.jpg?local=1',
        descriptor: {
            src: 'base-640.jpg?local=1',
            width: 640,
            height: 640,
            upgrades: [
                {src: 'https://cdn.example.com/up-1280.jpg', width: 1280, height: 1280},
                {src: 'up-1920.jpg', width: 1920, height: 1920}
            ]
        },
        rect: {top: 0, bottom: 700, left: 0, right: 1500, width: 1500, height: 700}
    });
    first.stack.driver.tick(16);
    assert.strictEqual(
        first.stack.images[0].src,
        'http://localhost/pages/guide/up-1920.jpg',
        'a relative upgrade resolves against the document base');
    assert.strictEqual(shown(first.host), 'base-640.jpg?local=1', 'the authored src is untouched');
    // Need 1000: the cross-origin absolute is the smallest sufficient —
    // it keeps its own origin rather than rebasing onto the document.
    const second = standaloneHost({
        document: {baseURI: 'http://localhost/pages/guide/'},
        descriptor: {
            src: 'base-640.jpg',
            width: 640,
            height: 640,
            upgrades: [{src: 'https://cdn.example.com/up-1280.jpg?q=1', width: 1280, height: 1280}]
        },
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    second.stack.driver.tick(16);
    assert.strictEqual(
        second.stack.images[0].src,
        'https://cdn.example.com/up-1280.jpg?q=1',
        'a cross-origin absolute src keeps its own base');
}

// The preparation fetch carries the host's authored CORS and referrer
// attributes to the same URL — nothing is added the page did not
// declare.
function preparationCarriesAuthoredCorsAttributes() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    host.setAttribute('crossorigin', 'anonymous');
    host.setAttribute('referrerpolicy', 'strict-origin');
    const {stack} = standaloneHost({
        host: host,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    assert.strictEqual(stack.images[0].crossOrigin, 'anonymous');
    assert.strictEqual(stack.images[0].referrerPolicy, 'strict-origin');
}

// decode() is the completion, not load: a loaded image that cannot
// decode is a failure — the baseline keeps the paint.
async function decodeRejectionKeepsTheBaseline() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].decodeShouldFail = true;
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), 'base-640.jpg', 'an undecodable upgrade never paints');
}

// Platforms without decode still complete on load — the load event is
// the fallback completion, not a second gate.
async function loadFallbackCommitsWithoutDecode() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    delete stack.images[0].decode;
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-1280.jpg'), 'load alone completes on a no-decode platform');
}

// No declared host: the module asks for nothing — no listeners, no
// observers, no frames.
function noDeclarationsStayQuiet() {
    FakeSubscription.reset();
    const stack = openStack({
        elements: {},
        scrollscrub: false,
        progressiveresolution: true
    });
    stack.driver.tick(16);
    assert.strictEqual(FakeSubscription.registry.length, 0, 'no subscriptions without a host');
    assert.strictEqual(stack.resizeObservers.length, 0, 'no observers without a host');
    assert.strictEqual(stack.driver.pending(), 0, 'no frames scheduled');
    assert.strictEqual(stack.images.length, 0);
}

// Without native Promise the enhancement cannot exist: every load and
// decode completion settles through one. The module binds nothing — no
// subscription, no observer, no module-started fetch — and the authored
// base stands through load and resize input. The reference host carries
// the same declaration with the module flag off, so its count is exactly
// what the shared dependencies legitimately own; the module adds zero.
async function absentPromiseLeavesTheAuthoredBase() {
    FakeSubscription.reset();
    const refHost = new Element('img', 'refhost');
    refHost.src = 'base-640.jpg';
    refHost.setAttribute('data-paste-progressiveresolution', '');
    refHost.setAttribute('data-image-sources', '#refdesc');
    refHost.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const refDesc = scriptJson('refdesc', descriptorDocument(640, [
        {src: 'up-1280.jpg', width: 1280, height: 1280}
    ]));
    const refStack = openStack({
        elements: {host: refHost, desc: refDesc},
        scrollscrub: false,
        progressiveresolution: false,
        globals: {Promise: undefined}
    });
    const baselineSubscriptions = FakeSubscription.registry.length;
    const baselineObservers = refStack.resizeObservers.length;
    const {stack, host} = standaloneHost({
        globals: {Promise: undefined},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.window.fireEvent('load');
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    await settlePromises();
    assert.strictEqual(shown(host), 'base-640.jpg', 'the authored base stands');
    assert.strictEqual(stack.images.length, 0, 'no module-started image request');
    assert.strictEqual(FakeSubscription.registry.length, baselineSubscriptions,
        'the enhancement bound no subscriptions');
    assert.strictEqual(stack.resizeObservers.length, baselineObservers,
        'the enhancement installed no observers');
}

async function backgroundHostUpgrades() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('up-1280.jpg') + '")');
}

// The descriptor's base must be the image the host actually displays:
// a descriptor naming a different picture would replace the author's
// content with an unrelated image — substitution, not sharpening.
// The mismatch leaves the host exactly as authored: no fetch, no
// observer, no shared listeners.
function mismatchedDescriptorStaysInert() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        hostSrc: 'actual-product.jpg',
        descriptor: {
            src: 'DIFFERENT-product.jpg',
            width: 640,
            height: 640,
            upgrades: [{src: 'wrong-upgrade.jpg', width: 1280, height: 1280}]
        },
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a foreign descriptor admitted an upgrade fetch');
    assert.strictEqual(shown(host), 'actual-product.jpg',
        'a foreign descriptor rewrote the authored image');
    assert.strictEqual(stack.resizeObservers.length, 0,
        'a foreign descriptor still took an observer');
    assert.strictEqual(FakeSubscription.registry.length, 0,
        'a foreign descriptor still claimed page listeners');
}

// A background host verifies against the computed baseline's single
// url(...) — the same document-base resolution applies.
async function matchingComputedBackgroundUpgrades() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the matching base admits the upgrade');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('up-1280.jpg') + '")');
}

function mismatchedComputedBackgroundStaysInert() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {'background-image': 'url("http://localhost/actual-product.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a descriptor that does not name the painted background fetched');
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'an unmatched host had its background written');
}

// Multi-layer declarations, gradients, and 'none' are not a base the
// module can verify — each stays exactly as authored.
function unverifiableBackgroundsStayInert() {
    FakeSubscription.reset();
    ['url("http://localhost/a.jpg"), url("http://localhost/b.jpg")',
        'linear-gradient(#fff, #000)',
        'none'].forEach(function (declared) {
        const {stack, host} = standaloneHost({
            host: new Element('div', 'host'),
            computedStyle: {'background-image': declared},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        assert.strictEqual(stack.images.length, 0,
            'an unverifiable background admitted work: ' + declared);
        assert.strictEqual(host.style.getPropertyValue('background-image'), '',
            'an unverifiable host had its background written: ' + declared);
    });
}

// A malformed host fails locally: its valid sibling still binds,
// upgrades, and paints.
async function mismatchedSiblingLeavesValidHostWorking() {
    FakeSubscription.reset();
    const good = new Element('img', 'good');
    good.src = 'good-640.jpg';
    good.setAttribute('width', '640');
    good.setAttribute('height', '640');
    good.setAttribute('data-paste-progressiveresolution', '');
    good.setAttribute('data-image-sources', '#good-desc');
    good.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const bad = new Element('img', 'bad');
    bad.src = 'bad-actual.jpg';
    bad.setAttribute('data-paste-progressiveresolution', '');
    bad.setAttribute('data-image-sources', '#bad-desc');
    bad.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const goodDesc = scriptJson('good-desc', {
        src: 'good-640.jpg',
        width: 640,
        height: 640,
        upgrades: [{src: 'good-1280.jpg', width: 1280, height: 1280}]
    });
    const badDesc = scriptJson('bad-desc', {
        src: 'bad-foreign.jpg',
        width: 640,
        height: 640,
        upgrades: [{src: 'bad-1280.jpg', width: 1280, height: 1280}]
    });
    const stack = openStack({
        elements: {good: good, 'good-desc': goodDesc, bad: bad, 'bad-desc': badDesc},
        scrollscrub: false,
        progressiveresolution: true
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1,
        'only the valid host admitted its upgrade');
    assert.strictEqual(stack.images[0].src, url('good-1280.jpg'));
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(good), url('good-1280.jpg'),
        'the valid sibling painted its upgrade');
    assert.strictEqual(shown(bad), 'http://localhost/bad-actual.jpg',
        'the mismatched sibling kept its authored image');
}

// A picture wrapper owns its img's source selection natively — the
// enhancement passes the host over entirely.
function pictureOwnedHostsAreSkipped() {
    FakeSubscription.reset();
    const picture = new Element('picture', 'picture');
    const host = new Element('img', 'host');
    const {stack} = standaloneHost({
        host: host,
        parent: picture,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a picture-owned img admitted enhancement work');
}

// A source that failed is remembered: later reevaluations re-read the
// policy and geometry as before, but the same miss is not fetched
// again on every resize.
async function failedSourceIsNotRetriedOnReevaluation() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade was requested');
    stack.images[0].fail();
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    for (let round = 0; round < 4; round += 1) {
        stack.window.fireEvent('resize');
        stack.driver.tick(32 + round);
    }
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(stack.images.length, 1, 'a failed source is not fetched again');
    assert.strictEqual(shown(host), 'base-640.jpg', 'the baseline stands');
}

// Resolution demand is honest about the fit the display applies: an
// image host's object-fit cover scales the intrinsic size, so the need
// lands on the larger candidate — not the one plain painted width
// would suggest.
async function objectFitCoverDemandsTheLargerCandidate() {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        descriptor: {src: 'base-640.jpg', width: 400, height: 800, upgrades: [
            {src: 'up-800.jpg', width: 800, height: 1600},
            {src: 'up-1920.jpg', width: 1920, height: 3840}
        ]},
        rect: {top: 0, left: 0, width: 500, height: 2400, right: 500, bottom: 2400},
        computedStyle: {'object-fit': 'cover'}
    });
    stack.driver.tick(16);
    // cover: scale = max(500/400, 2400/800) = 3 → need 1200 → 1920 wins.
    assert.strictEqual(stack.images.length, 1);
    assert.strictEqual(stack.images[0].src, url('up-1920.jpg'),
        'the cover-cropped need selects the larger representation');
}

// An outstanding request occupies its physical slot until the
// operation settles: while a need keeps moving, each newer answer
// waits — one outstanding fetch at a time, and the settle admits the
// latest intent rather than replaying every intermediate one.
async function inFlightPreparationKeepsItsSlotUntilSettle() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        descriptor: {src: 'base-640.jpg', width: 640, height: 1280, upgrades: [
            {src: 'up-800.jpg', width: 800, height: 1600},
            {src: 'up-1200.jpg', width: 1200, height: 2400},
            {src: 'up-1600.jpg', width: 1600, height: 3200},
            {src: 'up-2000.jpg', width: 2000, height: 4000}
        ]},
        rect: {top: 0, bottom: 700, left: 0, right: 700, width: 700, height: 700}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(
        stack.images.map(function (image) { return image.src; }),
        [url('up-800.jpg')],
        'the first need admits exactly one upgrade fetch');

    // The need moves three times before anything settles — each new
    // evaluation wants a different source, but the outstanding request
    // still owns the slot and its result keeps its worth.
    [1100, 1500, 3000].forEach(function (width, round) {
        host.rect = {top: 0, bottom: 700, left: 0, right: width, width: width, height: 700};
        stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
        stack.window.fireEvent('resize');
        stack.driver.tick(32 + round);
        assert.strictEqual(stack.images.length, 1,
            'the in-flight request holds its slot until it settles');
    });

    // The landed rep is still an improvement over the baseline — the
    // settle paints it, then the freed slot admits the latest intent.
    stack.images[0].succeed(800, 1600);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-800.jpg'),
        'the useful settled result still improves the paint');
    assert.strictEqual(stack.images.length, 2,
        'the freed slot admits once — not once per skipped intent');
    assert.strictEqual(stack.images[1].src, url('up-2000.jpg'),
        'the settle admits the latest intent, not a stale one');
    stack.images[1].succeed(2000, 4000);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('up-2000.jpg'), 'the newest candidate commits');
}

// Demand moving mid-flight is reprioritization, not invalidation: the
// in-flight 1280 stays accounted, its settle still improves the paint,
// and the next evaluation honestly asks for 1600 — whose failure
// leaves the committed 1280 standing.
async function movedPreferenceKeepsTheUsefulSettledResult() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        descriptor: descriptorDocument(640, [
            {src: 'up-1280.jpg', width: 1280, height: 1280},
            {src: 'up-1600.jpg', width: 1600, height: 1600}
        ])
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the 1280 preparation admitted');
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    // The host grows mid-flight — 1600 is now preferred.
    host.rect = {top: 0, bottom: 700, left: 0, right: 1600, width: 1600, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1,
        'reprioritization discards nothing — the op keeps its slot');
    // The 1280 lands: same content, inside the cap, sharper than the
    // displayed baseline — it paints.
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the useful result commits against the fresh snapshot');
    // Honest next demand: 1600 is wanted and fails — the committed
    // 1280 stands.
    const up1600 = stack.images.filter(function (image) {
        return image.src === url('up-1600.jpg');
    })[0];
    assert.ok(up1600, 'the new preference admits after the slot frees');
    up1600.fail();
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the failed preference leaves the landed improvement standing');
    assert.strictEqual(stack.images.filter(function (image) {
        return image.src === url('up-1600.jpg');
    }).length, 1, 'the failed URL is not retried');
}

// Demand that flips away and back before settlement is still one
// request — the operation's identity is the admitted work, not the
// preference of the moment. No duplicate preparation of the same
// useful result.
async function demandFlipFlopDoesNotDuplicateTheUsefulRequest() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        descriptor: descriptorDocument(640, [
            {src: 'up-1280.jpg', width: 1280, height: 1280},
            {src: 'up-1600.jpg', width: 1600, height: 1600}
        ])
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    // Away to 1600 and back to 1280 before the request settles.
    host.rect = {top: 0, bottom: 700, left: 0, right: 1600, width: 1600, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 1,
        'a demand flip-flop prepares nothing twice');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the same useful result still commits');
}

// Optional upgrades start as soon as a pass asks for them: a page
// still loading — a stalled resource elsewhere holding its load event
// open — never holds an upgrade back, and the module subscribes to no
// load event at all.
async function upgradesStartWithoutWaitingForLoad() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        document: {readyState: 'loading'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    assert.strictEqual(FakeSubscription.registry.filter(function (subscription) {
        return subscription.name === 'load' && subscription.target === stack.window;
    }).length, 0, 'the module still waits on the document load event');
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade waited for load');
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the upgrade did not commit while the page was loading');
}

// A host with no painted area wants nothing — zero height is zero
// demand, not a fall back to whatever the width alone would have
// asked. Expanding it later and delivering the ordinary observer
// notice admits the appropriate upgrade exactly once.
async function collapsedHostRequestsNothing() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 0, left: 0, right: 1600, width: 1600, height: 0}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0,
        'a collapsed host has no painted pixels to sharpen');
    assert.strictEqual(shown(host), 'base-640.jpg');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1600, width: 1600, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1, 'the expansion admits exactly once');
    assert.strictEqual(stack.images[0].src, url('up-1920.jpg'),
        'the painted need picks the smallest sufficient rung');
}

// The module header's documented example page, reconstructed verbatim:
// img.product-still with its intrinsic dimensions and complete
// descriptor — a relative base, a relative 1280 rung, and a 1920 rung
// on an image subdomain — under the stylesheet's inherited unitless
// cap. The cap is the page's breakpoint work: at its smaller value the
// smallest-sufficient upgrade is refused and the base stands; the
// wider media value admits exactly the candidate the ladder describes.
async function documentedExamplePageCapsByStylesheet() {
    FakeSubscription.reset();
    const host = new Element('img', 'product-still');
    const {stack} = standaloneHost({
        host: host,
        hostSrc: '/images/product-still-640.webp',
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        computedStyle: {'--paste-resolution-max-width': '960'},
        descriptor: {
            src: '/images/product-still-640.webp',
            width: 640,
            height: 640,
            upgrades: [
                {src: '/images/product-still-1280.webp', width: 1280, height: 1280},
                {src: 'https://images-b.example.com/product-still-1920.webp',
                    width: 1920, height: 1920}
            ]
        }
    });
    stack.driver.tick(16);
    // Painted 1000 wide at DPR 1 wants more than the 640 base, but the
    // 960 cap filters both rungs — the authored image stands.
    assert.strictEqual(stack.images.length, 0,
        'the 960 cap refuses the rungs the page ruled out');
    assert.strictEqual(shown(host), '/images/product-still-640.webp',
        'the authored baseline stands under its stylesheet cap');

    // The wider media assigns 1920: the smallest sufficient rung
    // admits, lands, and commits — the cross-subdomain 1920 stays out
    // of reach while 1280 is sufficient.
    host.computedStyle['--paste-resolution-max-width'] = '1920';
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1,
        'the wider cap admits the smallest sufficient rung');
    assert.strictEqual(stack.images[0].src,
        url('images/product-still-1280.webp'));
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16); // the parked settle reconciles on the next pass
    assert.strictEqual(shown(host), url('images/product-still-1280.webp'),
        'the documented upgrade commits');
}

// Completions park on their operation records — settlement itself
// performs no geometry reads and no source writes. The scheduled pass
// collects every dirty host's policy and geometry first, then paints:
// reads for all hosts precede writes for any host.
async function settlementsParkUntilTheBatchedPass() {
    FakeSubscription.reset();
    const events = [];
    const hostFor = function (name) {
        const host = new Element('img', name);
        host.src = name + '-640.jpg';
        host.setAttribute('width', '640');
        host.setAttribute('height', '640');
        host.setAttribute('data-paste-progressiveresolution', '');
        host.setAttribute('data-image-sources', '#' + name + '-desc');
        host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
        host.computedStyle = {};
        const readRect = host.getBoundingClientRect.bind(host);
        host.getBoundingClientRect = function () {
            events.push('read:' + name);
            return readRect();
        };
        const setAttribute = host.setAttribute.bind(host);
        host.setAttribute = function (attribute, value) {
            if (attribute === 'srcset' || attribute === 'sizes') {
                events.push('write:' + name);
            }
            setAttribute(attribute, value);
        };
        return host;
    };
    const hostA = hostFor('a');
    const hostB = hostFor('b');
    const descFor = function (name) {
        return scriptJson(name + '-desc', {
            src: name + '-640.jpg',
            width: 640,
            height: 640,
            upgrades: [{src: 'up-1280.jpg', width: 1280, height: 1280}]
        });
    };
    const descA = descFor('a');
    const descB = descFor('b');
    const stack = openStack({
        elements: {a: hostA, 'a-desc': descA, b: hostB, 'b-desc': descB},
        scrollscrub: false,
        progressiveresolution: true
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 2, 'both upgrades admitted');
    // Settlement is bookkeeping only: no reads, no writes.
    events.length = 0;
    stack.images[0].succeed(1280, 1280);
    stack.images[1].succeed(1280, 1280);
    await settlePromises();
    assert.deepStrictEqual(events, [],
        'settlement performs no geometry reads or source writes');
    assert.strictEqual(shown(hostA), 'http://localhost/a-640.jpg', 'nothing painted at settle');
    assert.strictEqual(shown(hostB), 'http://localhost/b-640.jpg', 'nothing painted at settle');
    // The next pass measures both hosts before either paint.
    stack.driver.tick(16);
    const firstWrite = events.findIndex(function (event) {
        return event.indexOf('write:') === 0;
    });
    assert.ok(firstWrite > 0, 'the pass committed the improvements');
    assert.ok(events.slice(0, firstWrite).every(function (event) {
        return event.indexOf('read:') === 0;
    }), 'every read precedes every write');
    assert.ok(events.some(function (event) { return event === 'read:a'; }) &&
        events.some(function (event) { return event === 'read:b'; }),
        'both hosts were measured in the same pass');
    assert.strictEqual(shown(hostA), url('up-1280.jpg'),
        'the first host painted without further input');
    assert.strictEqual(shown(hostB), url('up-1280.jpg'),
        'the second host painted without further input');
}

// A decode implementation that throws synchronously is a failed
// preparation, not a stranded one: the op settles, the baseline keeps
// standing, and a later re-evaluation still runs fresh work.
async function throwingDecodeSettlesThePreparation() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'no preparation started');
    const image = stack.images[0];
    image.decode = function () { throw new Error('decode was wrapped'); };
    image.succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(host), 'base-640.jpg',
        'a thrown decode still committed the failed preparation');

    // The failure is settled, not parked: a grown painted need starts a
    // new preparation instead of waiting on a slot that never frees.
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 2,
        'the thrown decode left the preparation slot occupied forever');
    assert.strictEqual(stack.images[1].src, url('up-1920.jpg'),
        'the follow-up evaluation did not pick the newly sufficient rung');
}

// A thenable that is not one — decode returning a plain value or an
// object without then — is the same failed preparation boundary.
async function nonPromiseDecodeSettlesAsFailure() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    const image = stack.images[0];
    image.decode = function () { return 42; };
    image.succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(host), 'base-640.jpg',
        'a non-promise decode answer committed anyway');
}

// The shared observer is one facility for every host on the page; a
// constructor that throws retires resize-driven re-evaluation without
// costing the hosts their bind-time preparation.
async function poisonedObserverKeepsBindTimePreparation() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        window: {ResizeObserver: function () { throw new Error('observer poisoned'); }}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1,
        'a poisoned observer aborted the initial evaluation');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'the prepared upgrade never committed');
}

// Another script owns its writes: a src it installs while the upgrade
// fetches is content the module never painted — the settled candidate
// withdraws its presentation claim instead of clobbering the
// replacement, and admissions stop with the ownership.
async function foreignSrcReplacementWithdrawsTheLatePaint() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'one upgrade prepares');
    host.src = 'https://cdn.other.example/replaced.jpg';
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(host), 'https://cdn.other.example/replaced.jpg',
        'the late upgrade painted over another script\'s source');
    stack.driver.tick(16);
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1,
        'a withdrawn host kept admitting fetches');
}

// The same claim withdrawal on a background host: the inline
// declaration a foreign script wrote is not the empty inline the
// module adopted, so the painted rung must not land.
async function foreignBackgroundReplacementWithdrawsTheLatePaint() {
    FakeSubscription.reset();
    const host = new Element('div', 'bg');
    const {stack} = standaloneHost({
        host: host,
        imageProperty: 'background-image',
        computedStyle: {'background-image': 'url("base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'one upgrade prepares');
    host.style.setProperty('background-image', 'url("https://foreign.example/x.jpg")');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("https://foreign.example/x.jpg")',
        'the late upgrade painted over another script\'s declaration');
}

// A srcset authored after binding hands selection back to the
// platform: the pending upgrade's commit must defer to it.
async function aLateSrcsetWithdrawsThePendingPaint() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'one upgrade prepares');
    host.setAttribute('srcset', 'native-1x.jpg 1x, native-2x.jpg 2x');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.getAttribute('srcset'), 'native-1x.jpg 1x, native-2x.jpg 2x',
        'the upgrade painted over a native srcset selection');
    assert.strictEqual(host.getAttribute('sizes'), null,
        'the withdrawn claim wrote a sizes beside the native srcset');
    assert.strictEqual(host.src, 'base-640.jpg');
}

// window.Image is a platform facility: a replaced constructor
// that throws settles the requesting host's preparation failed while
// every other host's pass continues uninterrupted.
async function aThrowingImageConstructorSettlesOnlyItsOwnHost() {
    FakeSubscription.reset();
    const localReg = imageRegistry();
    let threw = false;
    const hostFor = function (name) {
        const host = new Element('img', name);
        host.src = 'base-640.jpg';
        host.setAttribute('width', '640');
        host.setAttribute('height', '640');
        host.setAttribute('data-paste-progressiveresolution', '');
        host.setAttribute('data-image-sources', '#desc');
        host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
        host.computedStyle = {};
        return host;
    };
    const bad = hostFor('bad');
    const good = hostFor('good');
    const desc = scriptJson('desc', descriptorDocument(640, [
        {src: 'up-1280.jpg', width: 1280, height: 1280},
        {src: 'up-1920.jpg', width: 1920, height: 1920}
    ]));
    const stack = openStack({
        elements: {bad: bad, good: good, desc: desc},
        scrollscrub: false,
        progressiveresolution: true,
        window: {Image: function () {
            if (!threw) {
                threw = true;
                throw new Error('Image constructor poisoned');
            }
            const image = localReg.Image();
            image.nodeType = 1;
            return image;
        }}
    });
    stack.driver.tick(16);
    assert.strictEqual(localReg.images.length, 1,
        'the poisoned construction aborted the whole pass');
    assert.strictEqual(localReg.images[0].src, url('up-1280.jpg'));
    localReg.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(good), url('up-1280.jpg'),
        'the healthy host\'s upgrade never committed');
    assert.strictEqual(shown(bad), 'http://localhost/base-640.jpg',
        'the poisoned host lost its authored baseline');
}

// A URL carrying a quote is legal content: painting it inside a
// double-quoted url() without escaping produces a declaration the CSS
// parser discards — the paint must serialize the escapes.
async function aQuotedUrlPaintsAsValidCss() {
    FakeSubscription.reset();
    const host = new Element('div', 'bg');
    const {stack} = standaloneHost({
        host: host,
        imageProperty: 'background-image',
        computedStyle: {'background-image': 'url("base-640.jpg")'},
        descriptor: {src: 'base-640.jpg', width: 640, height: 640, upgrades: [
            {src: 'data:image/svg+xml,<svg a="b"></svg>', width: 1280, height: 1280}
        ]},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'one upgrade prepares');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("data:image/svg+xml,<svg a=\\"b\\"></svg>")',
        'the painted declaration left the embedded quote unescaped');
}

// The reading side of the same contract: a computed baseline
// serializing its URL with an escaped quote must still identify as
// its descriptor's base, or the host never binds.
async function anEscapedComputedBaselineStillBinds() {
    FakeSubscription.reset();
    const host = new Element('div', 'bg');
    const {stack} = standaloneHost({
        host: host,
        imageProperty: 'background-image',
        computedStyle: {'background-image': 'url("base-6\\"40.jpg")'},
        descriptor: {src: 'base-6"40.jpg', width: 640, height: 640, upgrades: [
            {src: 'up-1280.jpg', width: 1280, height: 1280}
        ]},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1,
        'the escaped authored URL never matched its descriptor');
}

// And the flip side of shared ownership: several hosts share the one
// observer instead of constructing one each.
function declaredHostsShareOneObserver() {
    FakeSubscription.reset();
    const second = new Element('img', 'host2');
    second.src = 'base-640.jpg';
    second.setAttribute('data-paste-progressiveresolution', '');
    second.setAttribute('data-image-sources', '#desc');
    second.rect = {top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600};
    const {stack} = standaloneHost({elements: {host2: second}});
    stack.driver.tick(16);
    assert.strictEqual(stack.resizeObservers.length, 1,
        'each declared host constructed its own ResizeObserver');
}

// Each case registers with the Node test runner under its function name.
test(sufficientBaseFetchesNothing);
test(needSelectsSmallestSufficientUpgrade);
test(capRestrictsButNeverBlocksTheBase);
test(largerCapChoosesTheLargestEligible);
test(capDropMidFlightRefusesTheCommit);
test(neverDowngradeOnShrink);
test(resizeRereadsPolicyWithoutGeometryChange);
test(containerQueryPolicyIsObserved);
test(sequenceOwnedHostsAreSkipped);
test(nativeSrcsetHostsAreSkipped);
test(missingDescriptorStaysInert);
test(malformedDescriptorJsonStaysInert);
test(failedUpgradeKeepsTheBaseline);
test(failedTopRungFallsToTheSurvivingRung);
test(everyImprovingRungFailedKeepsTheBaseline);
test(relativeSourcesResolveAgainstTheDocumentBase);
test(preparationCarriesAuthoredCorsAttributes);
test(decodeRejectionKeepsTheBaseline);
test(loadFallbackCommitsWithoutDecode);
test(noDeclarationsStayQuiet);
test(absentPromiseLeavesTheAuthoredBase);
test(backgroundHostUpgrades);
test(mismatchedDescriptorStaysInert);
test(matchingComputedBackgroundUpgrades);
test(mismatchedComputedBackgroundStaysInert);
test(unverifiableBackgroundsStayInert);
test(mismatchedSiblingLeavesValidHostWorking);
test(pictureOwnedHostsAreSkipped);
test(failedSourceIsNotRetriedOnReevaluation);
test(objectFitCoverDemandsTheLargerCandidate);
test(inFlightPreparationKeepsItsSlotUntilSettle);
test(movedPreferenceKeepsTheUsefulSettledResult);
test(demandFlipFlopDoesNotDuplicateTheUsefulRequest);
test(upgradesStartWithoutWaitingForLoad);
test(collapsedHostRequestsNothing);
test(documentedExamplePageCapsByStylesheet);
test(settlementsParkUntilTheBatchedPass);
test(throwingDecodeSettlesThePreparation);
test(nonPromiseDecodeSettlesAsFailure);
test(poisonedObserverKeepsBindTimePreparation);
test(foreignSrcReplacementWithdrawsTheLatePaint);
test(foreignBackgroundReplacementWithdrawsTheLatePaint);
test(aLateSrcsetWithdrawsThePendingPaint);
test(aThrowingImageConstructorSettlesOnlyItsOwnHost);
test(aQuotedUrlPaintsAsValidCss);
test(anEscapedComputedBaselineStillBinds);
test(declaredHostsShareOneObserver);

// An unsized img lays out from its source's pixels — a plain src
// replacement would change the box with the pixels. A width descriptor
// carries the upgrade instead, with the module's own sizes pinned to
// the base's intrinsic width: the authored src stands, and because the
// descriptor is the only srcset candidate (src is never added beside a
// width descriptor) every device pixel ratio — DPR 1 included —
// selects it, at the same layout size.
async function unsizedHostUpgradesThroughWidthDescriptor() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        unsized: true,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.src, 'base-640.jpg',
        'the baseline src was replaced instead of kept as fallback');
    assert.strictEqual(host.getAttribute('srcset'),
        url('up-1280.jpg') + ' 1280w',
        'the upgrade did not commit as a width descriptor');
    assert.strictEqual(host.getAttribute('sizes'), '640px',
        'sizes does not hold the base layout width');
}

// A stylesheet edit while the fetch flew moves the computed source the
// module last confirmed — the decode's late arrival must not install
// the upgrade over somebody else's presentation.
async function aStylesheetTakeoverWithdrawsTheLatePaint() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        imageProperty: 'background-image',
        computedStyle: {'background-image': 'url("base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade never admitted');
    host.computedStyle['background-image'] = 'url("somebody-else.jpg")';
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.style.getPropertyValue('background-image'), '',
        'a late commit clobbered a stylesheet replacement');
    // Ownership stays withdrawn: later passes fetch nothing more.
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1,
        'a foreign-owned display kept admitting work');
}

// The baseline declaration's priority is owned context: an authored
// !important survives the upgrade write rather than being demoted to a
// normal declaration the cascade could outrank.
async function anAuthoredImportantPrioritySurvivesThePaint() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    // Authored before the module defines — the baseline verify reads
    // exactly this declaration.
    host.style.setProperty('background-image', 'url("base-640.jpg")', 'important');
    const {stack} = standaloneHost({
        host: host,
        imageProperty: 'background-image',
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade never admitted');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.style.getPropertyValue('background-image'),
        'url("' + url('up-1280.jpg') + '")',
        'the upgrade never committed');
    assert.strictEqual(host.style.getPropertyPriority('background-image'), 'important',
        'the paint demoted an authored !important');
}

// A stylesheet !important above the inline layer means the written
// candidate never becomes the presentation: the commit leaves the
// display bookkeeping where it was and the host stands down — no
// bookkeeping advance, no further admissions.
async function anUnwinnablePaintAdvancesNoBookkeeping() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        imageProperty: 'background-image',
        computedStyle: {'background-image': 'url("base-640.jpg") !important'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade never admitted');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    // The declaration was written but never displayed — the host
    // withdraws rather than retry the same losing paint every pass.
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1,
        'a display the module cannot own kept admitting work');
}

// A listener release that throws can strand a physical claim — never
// the operation: the op settles in spite of it, its completion
// commits, and the host's later evaluations keep working.
async function aThrowingListenerReleaseStillSettles() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the upgrade never admitted');
    stack.images[0].removeEventListener = function () {
        throw new Error('removeEventListener poisoned');
    };
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(host), url('up-1280.jpg'),
        'a throwing release stranded the settled preparation');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 2,
        'the freed slot never admitted the next rung');
}

test(unsizedHostUpgradesThroughWidthDescriptor);
test(aStylesheetTakeoverWithdrawsTheLatePaint);
test(anAuthoredImportantPrioritySurvivesThePaint);
test(anUnwinnablePaintAdvancesNoBookkeeping);
test(aThrowingListenerReleaseStillSettles);

// The width descriptor's sizes is the base's intrinsic width, not the
// rendered box: a transform or a container that scales the painted box
// must not pin the intrinsic layout at the scaled size. Here the box
// renders 1280 wide (a scale(2) on a 640 layout) — the descriptor is
// still the rung over the base's own 640.
async function widthDescriptorSizesFollowTheBaseNotTheRenderedBox() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        unsized: true,
        rect: {top: 0, bottom: 1280, left: 0, right: 1280, width: 1280, height: 1280}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'));
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(host.getAttribute('sizes'), '640px',
        'the rendered box, not the base width, set the layout size');
    assert.strictEqual(host.getAttribute('srcset'), url('up-1280.jpg') + ' 1280w');
}

// sizes is part of the module's claim once written: another script
// that rewrites it owns the presentation — the module stands down,
// removes the srcset it wrote (it would now mis-size against the other
// writer's sizes), keeps the other writer's sizes, and commits nothing
// more. An authored sizes is never overwritten: the host is natively
// governed and passed over. A refused srcset write removes the module
// sizes it had just written.
async function moduleSizesIsTrackedAndRestored() {
    FakeSubscription.reset();
    const first = standaloneHost({
        unsized: true,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    first.stack.driver.tick(16);
    first.stack.images[0].succeed(1280, 1280);
    await settlePromises();
    first.stack.driver.tick(16);
    assert.strictEqual(first.host.getAttribute('sizes'), '640px');
    first.host.setAttribute('sizes', '100vw');
    first.host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    first.stack.resizeObservers.forEach(function (observer) { observer.trigger(); });
    first.stack.driver.tick(32);
    assert.strictEqual(first.stack.images.length, 1,
        'a foreign sizes write did not withdraw the claim');
    assert.strictEqual(first.host.getAttribute('sizes'), '100vw', 'the foreign sizes was touched');
    assert.strictEqual(first.host.getAttribute('srcset'), null,
        'the stood-down module left its srcset behind');

    FakeSubscription.reset();
    const authored = new Element('img', 'host');
    authored.setAttribute('sizes', '50vw');
    const native = standaloneHost({
        host: authored,
        unsized: true,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    native.stack.driver.tick(16);
    assert.strictEqual(native.stack.images.length, 0, 'an authored sizes host was enhanced');
    assert.strictEqual(authored.getAttribute('sizes'), '50vw', 'an authored sizes was overwritten');
    assert.strictEqual(native.stack.reported.length, 0, 'a natively governed host was reported');

    FakeSubscription.reset();
    const host = new Element('img', 'host');
    const setAttribute = host.setAttribute.bind(host);
    const refused = standaloneHost({
        host: host,
        unsized: true,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    host.setAttribute = function (name, value) {
        if (name === 'srcset') {
            throw new Error('srcset refused');
        }
        setAttribute(name, value);
    };
    refused.stack.driver.tick(16);
    refused.stack.images[0].succeed(1280, 1280);
    await settlePromises();
    refused.stack.driver.tick(16);
    assert.strictEqual(host.getAttribute('sizes'), null,
        'a half-written paint left the module sizes behind');
    assert.strictEqual(host.getAttribute('srcset'), null);
    assert.strictEqual(host.src, 'base-640.jpg');
}

// A foreign srcset write after the module's own commit: the module
// stands down and removes only the sizes it wrote, so the other
// script's srcset is sized by its own rules, never by the module's.
async function foreignSrcsetAfterCommitRemovesTheModuleSizes() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.getAttribute('sizes'), '640px', 'precondition: the module committed');
    host.setAttribute('srcset', 'other-400.jpg 400w, other-1600.jpg 1600w');
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(host.getAttribute('sizes'), null, 'the module sizes was left behind');
    assert.strictEqual(host.getAttribute('srcset'), 'other-400.jpg 400w, other-1600.jpg 1600w',
        'the other script\'s srcset was touched');
}

// A foreign src write after the module's own commit: the module's
// srcset would outrank it, so standing down removes the srcset and
// sizes the module wrote and the other script's src displays.
async function foreignSrcAfterCommitRemovesTheModuleSrcset() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    host.src = 'https://cdn.other.example/replaced.jpg';
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(shown(host), 'https://cdn.other.example/replaced.jpg',
        'the module srcset still outranks the other script\'s src');
    assert.strictEqual(host.getAttribute('sizes'), null);
}

// Every img host upgrades through the width descriptor — authored
// width and height attributes do not pin the box when CSS sets width:
// auto, so a plain src write could still change layout. The authored
// src stays as written.
async function sizedImgHostAlsoUpgradesThroughWidthDescriptor() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        computedStyle: {width: 'auto', height: 'auto'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(host.src, 'base-640.jpg', 'a sized img had its src replaced');
    assert.strictEqual(host.getAttribute('srcset'), url('up-1280.jpg') + ' 1280w');
    assert.strictEqual(host.getAttribute('sizes'), '640px');
}

// A rung whose URL cannot be written as a srcset candidate is never
// fetched for an img host: it could never be painted, and fetching it
// each pass would repeat forever.
function unpaintableRungIsNeverFetched() {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        // A trailing comma survives URL resolution, and a srcset
        // parser strips it from the candidate.
        descriptor: descriptorDocument(640, [
            {src: 'up-1280.jpg,', width: 1280, height: 1280}
        ]),
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0, 'an unpaintable rung was fetched');
}

// A background's intrinsic-size fit paints whatever source it is given
// at that source's own size — a larger rung would paint larger, not
// sharper: background-size auto at DPR 2 asks for nothing. An img's
// upgrade is a width descriptor that keeps the base's intrinsic size,
// so object-fit none at DPR 2 paints the base box at twice the pixels.
function intrinsicSizeFitsRequestNoUpgrade() {
    FakeSubscription.reset();
    const background = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {
            'background-image': 'url("http://localhost/base-640.jpg")',
            'background-size': 'auto'
        },
        window: {devicePixelRatio: 2},
        rect: {top: 0, bottom: 1400, left: 0, right: 2000, width: 2000, height: 1400}
    });
    background.stack.driver.tick(16);
    assert.strictEqual(background.stack.images.length, 0,
        'background-size auto at DPR 2 requested a zooming upgrade');

    FakeSubscription.reset();
    const image = standaloneHost({
        computedStyle: {'object-fit': 'none'},
        window: {devicePixelRatio: 2},
        rect: {top: 0, bottom: 1400, left: 0, right: 2000, width: 2000, height: 1400}
    });
    image.stack.driver.tick(16);
    assert.deepStrictEqual(image.stack.images.map(function (prepared) { return prepared.src; }),
        [url('up-1280.jpg')], 'object-fit none at DPR 2 did not ask for the density rung');

    FakeSubscription.reset();
    const scaled = standaloneHost({
        computedStyle: {'object-fit': 'scale-down'},
        window: {devicePixelRatio: 2},
        rect: {top: 0, bottom: 1400, left: 0, right: 2000, width: 2000, height: 1400}
    });
    scaled.stack.driver.tick(16);
    assert.deepStrictEqual(scaled.stack.images.map(function (prepared) { return prepared.src; }),
        [url('up-1280.jpg')], 'a non-shrinking scale-down at DPR 2 did not ask for the density rung');
}

// A two-value background-size stretches on both axes: '100% 100%' of a
// square base into a 600x1500 box needs the vertical scale (1500), not
// the width-only one (600, which the base already covers).
function twoValueBackgroundSizeReadsBothAxes() {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {
            'background-image': 'url("http://localhost/base-640.jpg")',
            'background-size': '100% 100%'
        },
        rect: {top: 0, bottom: 1500, left: 0, right: 600, width: 600, height: 1500}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the stretched axis demanded nothing');
    assert.strictEqual(stack.images[0].src, url('up-1920.jpg'));
}

// The device pixel ratio moves without a resize — a window dragged to
// another monitor. A media query on the current ratio stops matching;
// its change re-reads every host and re-arms on the new ratio.
async function devicePixelRatioChangeReevaluates() {
    FakeSubscription.reset();
    const queries = [];
    const removed = [];
    const matchMedia = function (query) {
        const list = mediaQueryList();
        list.query = query;
        list.removeEventListener = function (name, listener) {
            removed.push(query);
            list.listeners.splice(list.listeners.indexOf(listener), 1);
        };
        queries.push(list);
        return list;
    };
    const {stack, host} = standaloneHost({
        window: {matchMedia: matchMedia},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    assert.deepStrictEqual(queries.map(function (list) { return list.query; }),
        ['(resolution: 1dppx)'], 'no ratio query armed for the declared host');
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(16);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    // The monitor changes: no resize fires, only the query flips.
    stack.window.devicePixelRatio = 2;
    queries[0].set(false);
    assert.deepStrictEqual(removed, ['(resolution: 1dppx)'], 'the stale query kept its listener');
    assert.strictEqual(queries[1].query, '(resolution: 2dppx)', 'the watch did not re-arm');
    assert.strictEqual(queries[1].listeners.length, 1);
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 2, 'the ratio change was not re-read');
    assert.strictEqual(stack.images[1].src, url('up-1920.jpg'));
}

// The ratio watch is installed only for a page with hosts; a legacy
// query exposes addListener; a platform that cannot answer the query
// installs nothing and the module still works.
function devicePixelRatioWatchIsGuarded() {
    FakeSubscription.reset();
    let asked = 0;
    const quiet = openStack({
        elements: {},
        scrollscrub: false,
        progressiveresolution: true,
        window: {matchMedia: function () { asked += 1; return mediaQueryList(); }}
    });
    quiet.driver.tick(16);
    assert.strictEqual(asked, 0, 'a page with no hosts queried the ratio');

    FakeSubscription.reset();
    const legacy = [];
    standaloneHost({
        window: {matchMedia: function () {
            return {matches: true, addListener: function (listener) { legacy.push(listener); }};
        }}
    });
    assert.strictEqual(legacy.length, 1, 'the legacy listener pair was not used');

    FakeSubscription.reset();
    const throwing = standaloneHost({
        window: {matchMedia: function () { throw new Error('no media queries'); }},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    throwing.stack.driver.tick(16);
    assert.strictEqual(throwing.stack.images.length, 1,
        'an unanswerable ratio query cost the host its enhancement');
}

// One host's bind failing never costs a later declaration its
// enhancement: an <html> host whose ancestor walk reaches the document,
// an authored src the URL parser rejects, and a host whose surface
// throws all leave the next host binding.
async function oneHostsBindFailureNeverAbortsTheScan() {
    FakeSubscription.reset();
    // The root element as a background host: its parent is the
    // document, which has no computed style — a platform throws there.
    const html = new Element('html', 'root');
    html.setAttribute('data-paste-progressiveresolution', '');
    html.setAttribute('data-image-sources', '#root-desc');
    html.computedStyle = {'background-image': 'url("http://localhost/root-640.jpg")'};
    html.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    html.parentNode = {nodeType: 9};
    const rootDesc = scriptJson('root-desc', {src: 'root-640.jpg', width: 640, height: 640,
        upgrades: [{src: 'root-1280.jpg', width: 1280, height: 1280}]});
    // An img whose authored src the URL parser rejects.
    const unparseable = new Element('img', 'unparseable');
    unparseable.src = 'http://[bad';
    unparseable.setAttribute('data-paste-progressiveresolution', '');
    unparseable.setAttribute('data-image-sources', '#desc');
    // A host whose style surface throws.
    const hostile = new Element('div', 'hostile');
    hostile.setAttribute('data-paste-progressiveresolution', '');
    hostile.setAttribute('data-image-sources', '#desc');
    Object.defineProperty(hostile, 'style', {get: function () { throw new Error('style refused'); }});
    const strictStyle = function (element) {
        if (!element || element.nodeType !== 1) {
            throw new TypeError('getComputedStyle requires an element');
        }
        return {
            getPropertyValue: function (name) {
                const value = (element.computedStyle || {})[name];
                return value === undefined ? '' : String(value);
            }
        };
    };
    const {stack, host} = standaloneHost({
        document: {documentElement: html},
        elements: {'root-desc': rootDesc, unparseable: unparseable, hostile: hostile},
        window: {getComputedStyle: strictStyle},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    const requested = stack.images.map(function (image) { return image.src; }).sort();
    assert.deepStrictEqual(requested, [url('root-1280.jpg'), url('up-1280.jpg')],
        'a failing bind aborted the declaration scan');
    stack.images.forEach(function (image) { image.succeed(1280, 1280); });
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    assert.strictEqual(shown(unparseable), 'http://[bad');
}

// Inputs arriving before the frame runs arm one pass: the pending mark
// is set before the request.
async function inputsBeforeTheFrameArmOnePass() {
    FakeSubscription.reset();
    const driver = fakes.frameDriver();
    const requestPhased = driver.requestPhased;
    let calls = 0;
    driver.requestPhased = function (read, write) {
        calls += 1;
        return requestPhased(read, write);
    };
    const host = reflectSrc(new Element('img', 'host'));
    host.src = 'base-640.jpg';
    host.setAttribute('data-paste-progressiveresolution', '');
    host.setAttribute('data-image-sources', '#desc');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const stack = openStack({
        elements: {host: host, desc: scriptJson('desc', descriptorDocument(640, [
            {src: 'up-1280.jpg', width: 1280, height: 1280}
        ]))},
        scrollscrub: false,
        progressiveresolution: true,
        frameDriver: driver
    });
    stack.window.fireEvent('resize');
    stack.window.fireEvent('resize');
    assert.strictEqual(calls, 1, 'one frame was armed per input');
    driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    assert.strictEqual(calls, 2, 'the settlement did not arm the next pass');
    driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
}

// The Promise constructor is captured when the module defines: a page
// script replacing the global afterwards cannot break a later
// preparation.
async function promiseIsCapturedOnce() {
    FakeSubscription.reset();
    const driver = fakes.frameDriver();
    const requestPhased = driver.requestPhased;
    let moduleRealm = null;
    driver.requestPhased = function (read, write) {
        // The pass callback is a function of the module's own realm;
        // its constructor reaches that realm's global object.
        moduleRealm = moduleRealm || read.constructor('return this')();
        return requestPhased(read, write);
    };
    const host = new Element('img', 'host');
    host.src = 'base-640.jpg';
    host.setAttribute('width', '640');
    host.setAttribute('height', '640');
    host.setAttribute('data-paste-progressiveresolution', '');
    host.setAttribute('data-image-sources', '#desc');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const stack = openStack({
        elements: {host: host, desc: scriptJson('desc', descriptorDocument(640, [
            {src: 'up-1280.jpg', width: 1280, height: 1280}
        ]))},
        scrollscrub: false,
        progressiveresolution: true,
        frameDriver: driver
    });
    assert.ok(moduleRealm, 'the module never requested a frame');
    moduleRealm.Promise = function () {
        throw new Error('Promise replaced by a page script');
    };
    driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'the replaced global broke the preparation');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
}

// An Image substitute answering something that is not an element
// cannot carry load and error subscriptions — core would rebind them to
// the document and the operation would never settle. It is a failed
// preparation: nothing binds to the document, no request starts, and
// the authored base stands.
async function nonElementImageSubstituteFailsThePreparation() {
    FakeSubscription.reset();
    const substitutes = [];
    const {stack, host} = standaloneHost({
        window: {Image: function () {
            const substitute = {};
            substitutes.push(substitute);
            return substitute;
        }},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    await settlePromises();
    stack.driver.tick(32);
    assert.ok(substitutes.length >= 1, 'no preparation was attempted');
    assert.ok(substitutes.every(function (substitute) { return substitute.src === undefined; }),
        'a request started on a non-element substitute');
    assert.strictEqual(FakeSubscription.registry.filter(function (subscription) {
        return subscription.name === 'load' && subscription.target === stack.document;
    }).length, 0, 'image listeners were rebound to the document');
    assert.strictEqual(shown(host), 'base-640.jpg');
    // The failure is remembered per source: further passes do not retry.
    const attempts = substitutes.length;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    await settlePromises();
    stack.driver.tick(64);
    assert.strictEqual(substitutes.length, attempts, 'the failed source was retried');
}

// An astral code point escaped in the computed baseline decodes to its
// surrogate pair — truncating it would make the authored image differ
// from its own descriptor and the host would never bind.
function astralEscapedBaselineStillBinds() {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {'background-image': 'url("base-\\1F600 .jpg")'},
        descriptor: {src: 'base-😀.jpg', width: 640, height: 640, upgrades: [
            {src: 'up-1280.jpg', width: 1280, height: 1280}
        ]},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1,
        'the astral escape did not decode to the authored URL');
}

// Visibility returning re-reads every host; a visibilitychange to
// hidden does not.
function visibilityReturnRereadsHidingDoesNot() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        computedStyle: {'--paste-resolution-max-width': '700'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0);
    host.computedStyle['--paste-resolution-max-width'] = '2000';
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    assert.strictEqual(stack.driver.pending(), 0, 'hiding the page scheduled a pass');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 1, 'the returning page was not re-read');
}

// A background commit is a pure write: whether the declaration displays
// is verified by the next pass's read phase, never by a style read
// forced right after the write.
async function backgroundCommitReadsNoStyleAfterItsWrite() {
    FakeSubscription.reset();
    const events = [];
    const host = new Element('div', 'host');
    const setProperty = host.style.setProperty.bind(host.style);
    host.style.setProperty = function (name, value, priority) {
        events.push('write');
        setProperty(name, value, priority);
    };
    const box = host.getBoundingClientRect.bind(host);
    host.getBoundingClientRect = function () {
        events.push('box');
        return box();
    };
    // The module captures getComputedStyle when it defines, so the
    // counting wrapper is planted before that, around the fixture's own.
    // The fixture's cascade-aware getComputedStyle, taken from a bare page.
    const fixtureStyle = fakes.openUiStack({elements: {}, scrollscrub: false}).window.getComputedStyle;
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        window: {getComputedStyle: function (element) {
            events.push('read');
            return fixtureStyle(element);
        }},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    events.length = 0;
    stack.driver.tick(32);
    assert.deepStrictEqual(events, ['read', 'box', 'write'], 'the commit pass read style after its write');
    events.length = 0;
    stack.driver.tick(48);
    // The verification reads the computed source and nothing else: no
    // box, no policy re-measure, no further write.
    assert.deepStrictEqual(events, ['read'], 'the verifying pass re-measured the whole host');
    assert.strictEqual(host.style.getPropertyValue('background-image'), 'url("' + url('up-1280.jpg') + '")');
}

test(widthDescriptorSizesFollowTheBaseNotTheRenderedBox);
test(moduleSizesIsTrackedAndRestored);
test(foreignSrcsetAfterCommitRemovesTheModuleSizes);
test(foreignSrcAfterCommitRemovesTheModuleSrcset);
test(sizedImgHostAlsoUpgradesThroughWidthDescriptor);
test(unpaintableRungIsNeverFetched);
test(intrinsicSizeFitsRequestNoUpgrade);
test(twoValueBackgroundSizeReadsBothAxes);
test(devicePixelRatioChangeReevaluates);
test(devicePixelRatioWatchIsGuarded);
test(oneHostsBindFailureNeverAbortsTheScan);
test(inputsBeforeTheFrameArmOnePass);
test(promiseIsCapturedOnce);
test(nonElementImageSubstituteFailsThePreparation);
test(astralEscapedBaselineStillBinds);
test(visibilityReturnRereadsHidingDoesNot);
test(backgroundCommitReadsNoStyleAfterItsWrite);

// A malformed declaration keeps its host at the baseline and is
// reported once per host — a descriptive TypeError rethrown from the
// captured timer, never a console line. Hosts that are natively
// governed or sequence-owned are redundant, not malformed: no report.
function malformedDeclarationsReportOncePerHost() {
    FakeSubscription.reset();
    const make = function (id, sources, src) {
        const element = new Element('img', id);
        element.src = src || 'base-640.jpg';
        element.setAttribute('data-paste-progressiveresolution', '');
        if (sources !== null) {
            element.setAttribute('data-image-sources', sources);
        }
        element.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
        return element;
    };
    const broken = new Element('script', 'broken');
    broken.setAttribute('type', 'application/json');
    broken.textContent = '{not json';
    const bad = scriptJson('bad', {src: 'base-640.jpg', width: 640, height: 0});
    const missing = make('missing', null);
    const json = make('json', '#broken');
    const invalid = make('invalid', '#bad');
    const mismatch = make('mismatch', '#desc', 'other.jpg');
    const property = make('property', '#desc');
    property.setAttribute('data-image-property', 'poster');
    const native = make('native', '#desc');
    native.setAttribute('srcset', 'base-640.jpg 1x');
    const sequence = make('sequence', '#desc');
    sequence.setAttribute('data-paste-imagesequence', '#frames');
    const {stack} = standaloneHost({
        elements: {missing, json, invalid, mismatch, property, native, sequence, broken, bad},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    const messages = stack.reported.map(function (error) {
        assert.strictEqual(error.name, 'TypeError', 'a report was not a TypeError');
        return error.message;
    }).sort();
    assert.strictEqual(messages.length, 5, 'each malformed host reports exactly once: ' + messages.join(' | '));
    [/#invalid: descriptor dimensions/, /#json: data-image-sources #broken is not valid JSON/,
        /#mismatch: data-image-sources src does not match the authored src/,
        /#missing: data-image-sources must be a #fragment reference/,
        /#property: data-image-property must be src or background-image/].forEach(function (pattern, index) {
        assert.match(messages[index], pattern);
    });
    assert.strictEqual(stack.images.length, 1, 'only the sound host fetched');
    assert.strictEqual(mismatch.src, 'http://localhost/other.jpg');
}

// The cap reads through the shared grammar: '1e3', '0x500' or '+1280'
// is no cap at all — the same CSS caps imagesequence and this module
// alike — while a plain decimal caps.
function capUsesTheSharedPlainDecimalGrammar() {
    FakeSubscription.reset();
    ['1e3', '0x500', '+1280'].forEach(function (text) {
        const {stack} = standaloneHost({
            computedStyle: {'--paste-resolution-max-width': text},
            rect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500}
        });
        stack.driver.tick(16);
        assert.strictEqual(stack.images.length, 1, text + ' was read as a cap');
        assert.strictEqual(stack.images[0].src, url('up-1920.jpg'), text + ' narrowed the ladder');
    });
    const {stack} = standaloneHost({
        computedStyle: {'--paste-resolution-max-width': '1280.'},
        rect: {top: 0, bottom: 1500, left: 0, right: 1500, width: 1500, height: 1500}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images[0].src, url('up-1280.jpg'), 'a plain decimal cap was ignored');
}

// CORS and referrer attributes carry to the preparation only from an
// img host: a background fetch is not governed by them.
function backgroundHostCarriesNoCorsAttributes() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    host.setAttribute('crossorigin', 'use-credentials');
    host.setAttribute('referrerpolicy', 'no-referrer');
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    // The fixture image's own defaults: nothing was assigned.
    assert.strictEqual(stack.images[0].crossOrigin, null, 'a background host set crossOrigin');
    assert.strictEqual(stack.images[0].referrerPolicy, '', 'a background host set referrerPolicy');
}

// Picture ancestry is decided once at bind: later passes never walk
// the host's ancestors again.
async function passesNeverWalkTheAncestors() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    // The picture test reads each ancestor's tag name; the fixture's
    // own cascade walk reads only computed maps, so a tag-name read on
    // an ancestor is the module walking.
    let walks = 0;
    [host.parentNode, stack.document.documentElement].forEach(function (ancestor) {
        const tag = ancestor.tagName;
        Object.defineProperty(ancestor, 'tagName', {
            configurable: true,
            get: function () { walks += 1; return tag; }
        });
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    assert.strictEqual(walks, 0, 'a pass walked the host\'s ancestors');
}

// The inline priority is part of the module's claim: another script
// re-declaring the same value !important — or demoting an authored
// !important — owns the declaration now, and no later rung commits.
async function aForeignPriorityChangeWithdrawsTheClaim() {
    for (const priority of ['important', '']) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        if (priority === '') {
            host.style.setProperty('background-image', 'url("base-640.jpg")', 'important');
        }
        const {stack} = standaloneHost({
            host: host,
            computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        stack.images[0].succeed(1280, 1280);
        await settlePromises();
        stack.driver.tick(32);
        stack.driver.tick(48);
        const written = host.style.getPropertyValue('background-image');
        assert.strictEqual(written, 'url("' + url('up-1280.jpg') + '")', 'precondition: committed');
        host.style.setProperty('background-image', written, priority);
        host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
        stack.window.fireEvent('resize');
        stack.driver.tick(64);
        assert.strictEqual(stack.images.length, 1,
            'a foreign priority change (' + (priority || 'demotion') + ') kept admitting work');
    }
}

// Platform constructors and functions are captured at define: a page
// script replacing Image, URL, getComputedStyle, ResizeObserver or
// WeakMap afterwards changes nothing about the enhancement.
async function platformGlobalsAreCapturedOnce() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    const poisoned = function () { throw new Error('replaced by a page script'); };
    ['Image', 'URL', 'getComputedStyle', 'ResizeObserver', 'WeakMap'].forEach(function (name) {
        stack.window[name] = poisoned;
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1, 'a replaced global broke the preparation');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
}

// A WeakMap that throws costs only the observer: the host still binds
// and upgrades on its other inputs.
function hostileWeakMapKeepsTheEnhancement() {
    FakeSubscription.reset();
    let stack;
    assert.doesNotThrow(function () {
        stack = standaloneHost({
            window: {WeakMap: function () { throw new Error('hostile WeakMap'); }},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        }).stack;
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 1);
    assert.strictEqual(stack.resizeObservers.length, 0, 'an observer stood without its index');
}

test(malformedDeclarationsReportOncePerHost);
test(capUsesTheSharedPlainDecimalGrammar);
test(backgroundHostCarriesNoCorsAttributes);
test(passesNeverWalkTheAncestors);
test(aForeignPriorityChangeWithdrawsTheClaim);
test(platformGlobalsAreCapturedOnce);
test(hostileWeakMapKeepsTheEnhancement);

// A MutationObserver double: observe() watches the filtered attribute
// writes on its target and delivers their records on a microtask, as a
// browser does.
const mutationObserverDouble = require('./fakes.cjs').mutationObserverRegistry;

// A src another script writes after the module's commit — a carousel
// advancing, say — is noticed when it happens: the next frame stands
// the module down and the new picture displays, with no other input.
// The module's own srcset and sizes writes schedule nothing.
async function foreignSrcWriteIsNoticedWhenItHappens() {
    FakeSubscription.reset();
    const double = mutationObserverDouble();
    const {stack, host} = standaloneHost({
        window: {MutationObserver: double.MutationObserver},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    assert.strictEqual(double.instances.length, 1);
    assert.ok(double.instances[0].observed.indexOf(host) >= 0, 'the img host is not watched');
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'), 'precondition: committed');
    await settlePromises();
    assert.strictEqual(stack.driver.pending(), 0, 'the module\'s own writes scheduled a pass');
    host.src = 'https://cdn.other.example/next-slide.jpg';
    await settlePromises();
    assert.strictEqual(stack.driver.pending(), 1, 'the foreign write scheduled no pass');
    stack.driver.tick(48);
    assert.strictEqual(shown(host), 'https://cdn.other.example/next-slide.jpg',
        'the module srcset still outranks the other script\'s src');
    assert.strictEqual(host.getAttribute('sizes'), null);

    // A refusing MutationObserver leaves the enhancement and the
    // pass-time check in charge.
    FakeSubscription.reset();
    const refused = standaloneHost({
        window: {MutationObserver: function () { throw new Error('refused'); }},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    refused.stack.driver.tick(16);
    refused.stack.images[0].succeed(1280, 1280);
    await settlePromises();
    refused.stack.driver.tick(32);
    assert.strictEqual(shown(refused.host), url('up-1280.jpg'));
}

// Ownership is the src attribute text captured at bind, never the
// reflected URL: a same-document navigation that moves the document's
// base re-resolves img.src although nobody wrote it, and the module
// keeps its upgrade.
async function aBaseUrlMoveIsNotAForeignWrite() {
    FakeSubscription.reset();
    const host = new Element('img', 'host');
    let base = 'http://localhost/products/widget';
    Object.defineProperty(host, 'src', {
        configurable: true,
        get: function () {
            return new URL(host.getAttribute('src'), base).href;
        },
        set: function (value) {
            host.setAttribute('src', value);
        }
    });
    host.src = 'images/w-640.jpg';
    host.setAttribute('data-paste-progressiveresolution', '');
    host.setAttribute('data-image-sources', '#desc');
    host.rect = {top: 0, bottom: 600, left: 0, right: 600, width: 600, height: 600};
    const stack = openStack({
        elements: {host: host, desc: scriptJson('desc', {
            src: 'images/w-640.jpg', width: 640, height: 640,
            upgrades: [{src: 'images/w-1280.jpg', width: 1280, height: 1280}]
        })},
        scrollscrub: false,
        progressiveresolution: true,
        document: {baseURI: base},
        window: {devicePixelRatio: 2}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    const committed = 'http://localhost/products/images/w-1280.jpg 1280w';
    assert.strictEqual(host.getAttribute('srcset'), committed, 'precondition: committed');
    base = 'http://localhost/products/widget/';
    stack.document.baseURI = base;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(host.getAttribute('srcset'), committed,
        'a moved document base withdrew the module\'s own srcset');
    assert.strictEqual(host.getAttribute('sizes'), '640px');
}

// An img the author marked loading="lazy" fetches no upgrade while it
// is far from the page viewport; the page scrolling it within about one
// viewport admits it, and from then on it upgrades like any other host.
// The scroll probe reads the box alone.
async function lazyImgDefersItsUpgradeUntilNear() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        elementAttributes: {loading: 'lazy'},
        rect: {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'a far lazy img fetched an upgrade');
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0, 'a far lazy img fetched on resize');
    let boxes = 0;
    const box = host.getBoundingClientRect.bind(host);
    host.getBoundingClientRect = function () {
        boxes += 1;
        return box();
    };
    host.rect = {top: 2000, bottom: 2700, left: 0, right: 1000, width: 1000, height: 700};
    stack.window.pageYOffset = 1000;
    stack.window.fireEvent('scroll');
    stack.driver.tick(48);
    assert.strictEqual(boxes, 1, 'a scroll probe read more than the box');
    assert.strictEqual(stack.images.length, 0, 'a lazy img two viewports out fetched');
    host.rect = {top: 1500, bottom: 2200, left: 0, right: 1000, width: 1000, height: 700};
    stack.window.fireEvent('scroll');
    stack.driver.tick(64);
    assert.deepStrictEqual(stack.images.map(function (image) { return image.src; }), [url('up-1280.jpg')],
        'a lazy img within one viewport was not admitted');
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(80);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    boxes = 0;
    stack.window.fireEvent('scroll');
    stack.driver.tick(96);
    assert.strictEqual(boxes, 0, 'an admitted lazy img is still probed on scroll');

    // A lazy img already near at bind upgrades at once; an eager one
    // far away keeps the eager contract.
    FakeSubscription.reset();
    const near = standaloneHost({
        elementAttributes: {loading: 'LAZY'},
        rect: {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700}
    });
    near.stack.driver.tick(16);
    assert.strictEqual(near.stack.images.length, 1, 'a near lazy img was held back');
    FakeSubscription.reset();
    const eager = standaloneHost({
        rect: {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700}
    });
    eager.stack.driver.tick(16);
    assert.strictEqual(eager.stack.images.length, 1, 'an eager far img was held back');
}

// A decoded rung must be the image its descriptor declares: a width
// that differs, or an aspect ratio that leaves the descriptor's, would
// change the layout box. That rung fails for good; an image reporting
// no natural size cannot contradict the descriptor.
async function decodedSizeMustMatchTheDescriptor() {
    for (const natural of [[1200, 1200], [1280, 720]]) {
        FakeSubscription.reset();
        const {stack, host} = standaloneHost({
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        stack.images[0].succeed(natural[0], natural[1]);
        await settlePromises();
        stack.driver.tick(32);
        assert.strictEqual(shown(host), 'base-640.jpg',
            'a ' + natural.join('x') + ' decode committed as the 1280 rung');
        stack.window.fireEvent('resize');
        stack.driver.tick(48);
        assert.strictEqual(stack.images.length, 1, 'a mis-sized rung was fetched again');
    }
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed();
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(shown(host), url('up-1280.jpg'), 'an image without a natural size was refused');
}

// A decode the platform refuses while the document is hidden is
// withheld, not failed: nothing re-fetches it while hidden, the
// document becoming visible retries it once, and a refusal while
// visible is final. A hidden document runs no frame, so no frame
// ticks between a hidden refusal and the return to visible.
async function hiddenDecodeRefusalIsRetriedOnce() {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.document.hidden = true;
    stack.images[0].decodeShouldFail = true;
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.window.fireEvent('resize');
    assert.strictEqual(stack.images.length, 1, 'a withheld rung was fetched while hidden');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(64);
    assert.deepStrictEqual(stack.images.map(function (image) { return image.src; }),
        [url('up-1280.jpg'), url('up-1280.jpg')], 'the visible document did not retry the rung');
    stack.images[1].decodeShouldFail = true;
    stack.images[1].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(80);
    stack.document.hidden = true;
    stack.document.fireEvent('visibilitychange');
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length, 2, 'a refusal while visible was retried');
    assert.strictEqual(shown(host), 'base-640.jpg');

    // The retry is once: a second hidden refusal is final.
    FakeSubscription.reset();
    const twice = standaloneHost({
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    twice.stack.driver.tick(16);
    for (let round = 0; round < 2; round += 1) {
        twice.stack.document.hidden = true;
        const image = twice.stack.images[round];
        image.decodeShouldFail = true;
        image.succeed(1280, 1280);
        await settlePromises();
        twice.stack.document.hidden = false;
        twice.stack.document.fireEvent('visibilitychange');
        twice.stack.driver.tick(48 + round * 32);
    }
    assert.strictEqual(twice.stack.images.length, 2, 'a second hidden refusal was retried');
}

// A background host outside the document reads no computed source:
// that is no evidence against the claim, which stands — reattached,
// the host keeps upgrading.
async function aDetachedBackgroundHostKeepsTheClaim() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    const owned = host.style.getPropertyValue('background-image');
    const parent = host.parentNode;
    parent.removeChild(host);
    host.computedStyle['background-image'] = '';
    stack.driver.tick(48);
    assert.strictEqual(stack.driver.pending(), 0, 'an unread claim kept the frames running');
    parent.appendChild(host);
    host.computedStyle['background-image'] = owned;
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.deepStrictEqual(stack.images.map(function (image) { return image.src; }),
        [url('up-1280.jpg'), url('up-1920.jpg')], 'a detached host stood down');
}

// Near is near on both axes: a lazy carousel slide off to the side,
// or a box with no size at all, is not admitted.
async function aLazyImgOffToTheSideIsNotNear() {
    for (const rect of [
        {top: 0, bottom: 700, left: 3000, right: 4000, width: 1000, height: 700},
        {top: 0, bottom: 700, left: -2000, right: -1000, width: 1000, height: 700},
        {top: -2000, bottom: -1300, left: 0, right: 1000, width: 1000, height: 700},
        {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0}
    ]) {
        FakeSubscription.reset();
        const {stack, host} = standaloneHost({elementAttributes: {loading: 'lazy'}, rect: rect});
        stack.driver.tick(16);
        assert.strictEqual(stack.images.length, 0, 'a lazy img at ' + JSON.stringify(rect) + ' fetched');
        host.rect = {top: 0, bottom: 700, left: 100, right: 1100, width: 1000, height: 700};
        stack.window.fireEvent('scroll');
        stack.driver.tick(32);
        assert.deepStrictEqual(stack.images.map(function (image) { return image.src; }), [url('up-1280.jpg')],
            'a lazy img brought into view was not admitted');
    }
}

// A container-type that combines size containment with other container
// features is still a size container whose geometry can move the policy.
function combinedContainerTypeIsObserved() {
    FakeSubscription.reset();
    const container = new Element('div', 'container');
    container.computedStyle = {'container-type': 'inline-size scroll-state'};
    const {stack} = standaloneHost({
        parent: container,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    assert.ok(stack.resizeObservers.some(function (observer) {
        return observer.observed.indexOf(container) >= 0;
    }), 'a combined size container is not watched');
}

// While a background-image transition runs the computed value is a
// cross-fade that still carries the module's URL: the claim stands and
// is verified again each pass until the transition ends, then the
// passes stop. A computed value without the module's URL is another
// writer.
async function aBackgroundTransitionKeepsTheClaim() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    const written = 'url("' + url('up-1280.jpg') + '")';
    assert.strictEqual(host.style.getPropertyValue('background-image'), written, 'precondition: committed');
    host.computedStyle['background-image'] = 'cross-fade(url("http://localhost/base-640.jpg") 40%, ' +
        'url("http://localhost/up-1280.jpg")) !important';
    stack.driver.tick(48);
    assert.strictEqual(stack.driver.pending(), 1, 'a pending claim was not verified again');
    stack.driver.tick(64);
    assert.strictEqual(stack.driver.pending(), 1);
    delete host.computedStyle['background-image'];
    stack.driver.tick(80);
    assert.strictEqual(stack.driver.pending(), 0, 'a verified claim kept scheduling passes');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.window.fireEvent('resize');
    stack.driver.tick(96);
    assert.strictEqual(stack.images.length, 2, 'the transition cost the host its claim');
    assert.strictEqual(stack.images[1].src, url('up-1920.jpg'));

    FakeSubscription.reset();
    const other = new Element('div', 'host');
    const foreign = standaloneHost({
        host: other,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    foreign.stack.driver.tick(16);
    foreign.stack.images[0].succeed(1280, 1280);
    await settlePromises();
    foreign.stack.driver.tick(32);
    other.computedStyle['background-image'] = 'cross-fade(url("a.jpg"), url("b.jpg")) !important';
    foreign.stack.driver.tick(48);
    assert.strictEqual(foreign.stack.driver.pending(), 0);
    other.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    foreign.stack.window.fireEvent('resize');
    foreign.stack.driver.tick(64);
    assert.strictEqual(foreign.stack.images.length, 1, 'a foreign cross-fade kept the claim');
}

// A computed cross-fade the page never resolves is verified by its own
// passes for five seconds of frame time from the first pending read and
// no longer: the frames stop, the claim is never reverted, and the next
// input-driven pass treats the still-pending value as the module's own.
async function aPermanentCrossFadeStopsVerifyingAfterTheBound() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    const written = 'url("' + url('up-1280.jpg') + '")';
    host.computedStyle['background-image'] = 'cross-fade(url("http://localhost/base-640.jpg") 40%, ' +
        'url("http://localhost/up-1280.jpg")) !important';
    stack.driver.tick(48); // the first pending read
    let at = 48;
    while (at < 48 + 4990) {
        assert.strictEqual(stack.driver.pending(), 1, 'a pending claim stopped verifying inside the bound');
        stack.driver.tick(at += 16);
    }
    while (at < 48 + 5100 && stack.driver.pending() > 0) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 0, 'a permanent cross-fade kept requesting frames');
    assert.ok(at <= 48 + 5016, 'the verification outlived its bound');
    assert.strictEqual(host.style.getPropertyValue('background-image'), written,
        'a pending claim was reverted');
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    assert.strictEqual(stack.images.length, 2, 'the still-pending claim was not treated as owned');
    assert.strictEqual(stack.images[1].src, url('up-1920.jpg'));
    assert.strictEqual(stack.driver.pending(), 0, 'the input-driven pass re-armed verification');
}

// After a background commit the next pass verifies the claim once and
// then no more frames run; a cascade override found by that
// verification withdraws the claim for good.
async function aBackgroundCommitIsVerifiedOnce() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({
        host: host,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.strictEqual(stack.driver.pending(), 1, 'the commit armed no verification');
    stack.driver.tick(48);
    assert.strictEqual(stack.driver.pending(), 0, 'verification kept the frames running');

    FakeSubscription.reset();
    const overridden = new Element('div', 'host');
    const override = standaloneHost({
        host: overridden,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    override.stack.driver.tick(16);
    override.stack.images[0].succeed(1280, 1280);
    await settlePromises();
    override.stack.driver.tick(32);
    overridden.computedStyle['background-image'] = 'url("http://localhost/base-640.jpg") !important';
    override.stack.driver.tick(48);
    assert.strictEqual(override.stack.driver.pending(), 0);
    // The withdrawal is the verification's own: the override leaving
    // again does not restore the claim.
    delete overridden.computedStyle['background-image'];
    overridden.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    override.stack.window.fireEvent('resize');
    override.stack.driver.tick(64);
    assert.strictEqual(override.stack.images.length, 1, 'an overridden claim kept admitting work');
}

// Under a background-image transition the first computed read after a
// paint can still be the source the paint replaced; the transition
// reports the change on a later read. That predecessor keeps the claim
// pending, and the module's own url() then owns it. The same read with
// no transition on background-image is a cascade refusal.
function predecessorStyle(element) {
    return {getPropertyValue(name) {
        const sheet = (element.computedStyle || {})[name] || '';
        if (/\s*!important\s*$/.test(sheet)) return sheet.replace(/\s*!important\s*$/, '');
        return element.style.getPropertyValue(name) || sheet;
    }};
}

async function aTransitionedPredecessorKeepsTheClaim() {
    const start = async function (transition) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        const computedStyle = Object.assign({'background-image': 'url("http://localhost/base-640.jpg")'},
            transition);
        const {stack} = standaloneHost({
            host: host,
            computedStyle: computedStyle,
            window: {getComputedStyle: predecessorStyle},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        stack.images[0].succeed(1280, 1280);
        await settlePromises();
        stack.driver.tick(32);
        assert.strictEqual(host.style.getPropertyValue('background-image'),
            'url("' + url('up-1280.jpg') + '")', 'precondition: committed');
        // The computed value still reads as the replaced source.
        host.computedStyle['background-image'] = 'url("http://localhost/base-640.jpg") !important';
        return {host: host, stack: stack};
    };
    const grow = function (run, at) {
        run.host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
        run.stack.window.fireEvent('resize');
        run.stack.driver.tick(at);
    };
    const kept = await start({'transition-property': 'all', 'transition-duration': '0.3s',
        'transition-delay': '0s'});
    kept.stack.driver.tick(48); // still the predecessor
    assert.strictEqual(kept.stack.driver.pending(), 1, 'the predecessor read was not verified again');
    kept.host.computedStyle['background-image'] = 'url("http://localhost/up-1280.jpg")';
    kept.stack.driver.tick(64);
    assert.strictEqual(kept.stack.driver.pending(), 0, 'an owned claim kept scheduling passes');
    grow(kept, 80);
    assert.strictEqual(kept.stack.images.length, 2, 'the transition cost the host its claim');
    assert.strictEqual(kept.stack.images[1].src, url('up-1920.jpg'));

    const listed = await start({'transition-property': 'opacity, background-image',
        'transition-duration': '0s, 200ms', 'transition-delay': '0s'});
    listed.stack.driver.tick(48);
    assert.strictEqual(listed.stack.driver.pending(), 1, 'a listed background-image transition was missed');

    const cases = [
        {},
        {'transition-property': 'opacity', 'transition-duration': '0.3s', 'transition-delay': '0s'},
        {'transition-property': 'all', 'transition-duration': '0s', 'transition-delay': '0s'},
        {'transition-property': 'background-image', 'transition-duration': '0.2s', 'transition-delay': '-0.3s'}
    ];
    for (const transition of cases) {
        const refused = await start(transition);
        refused.stack.driver.tick(48);
        assert.strictEqual(refused.stack.driver.pending(), 0, JSON.stringify(transition));
        refused.host.computedStyle['background-image'] = 'url("http://localhost/up-1280.jpg")';
        grow(refused, 64);
        assert.strictEqual(refused.stack.images.length, 1,
            'a predecessor without a transition kept the claim: ' + JSON.stringify(transition));
    }
}

// A predecessor that never gives way is pending only inside the bound:
// past it the claim is a cascade refusal and the host stands down.
async function aTransitionedPredecessorLapsesAtTheBound() {
    FakeSubscription.reset();
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({
        host: host,
        window: {getComputedStyle: predecessorStyle},
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
            'transition-property': 'background', 'transition-duration': '0.3s', 'transition-delay': '0s'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    host.computedStyle['background-image'] = 'url("http://localhost/base-640.jpg") !important';
    stack.driver.tick(48); // the first pending read
    let at = 48;
    while (at < 48 + 4990) {
        assert.strictEqual(stack.driver.pending(), 1, 'a predecessor claim stopped verifying inside the bound');
        stack.driver.tick(at += 16);
    }
    while (at < 48 + 5100 && stack.driver.pending() > 0) {
        stack.driver.tick(at += 16);
    }
    assert.strictEqual(stack.driver.pending(), 0, 'a permanent predecessor kept requesting frames');
    assert.ok(at <= 48 + 5016, 'the verification outlived its bound');
    host.computedStyle['background-image'] = 'url("http://localhost/up-1280.jpg")';
    host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    stack.window.fireEvent('resize');
    stack.driver.tick(at += 16);
    assert.strictEqual(stack.images.length, 1, 'a lapsed predecessor was treated as owned');
}

// Where the host lists its animations, a background-image transition
// still in flight — inside its delay or running — keeps the claim
// pending whatever older source the computed value still names: two
// paints inside one transition delay leave the authored base computed,
// which is neither the claim nor its predecessor, and the host still
// upgrades once the transition reports the change. With the list
// present and no background-image transition in it, that value is
// another writer.
async function aListedTransitionKeepsChainedPaints() {
    const run = async function (listed) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        const state = {running: false};
        host.getAnimations = function () {
            return state.running ? [{transitionProperty: state.running}] : [];
        };
        const {stack} = standaloneHost({
            host: host,
            window: {getComputedStyle: predecessorStyle},
            computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
                'transition-property': 'background-image', 'transition-duration': '0.3s',
                'transition-delay': '3s'},
            descriptor: descriptorDocument(640, [
                {src: 'up-1280.jpg', width: 1280, height: 1280},
                {src: 'up-1920.jpg', width: 1920, height: 1920},
                {src: 'up-2560.jpg', width: 2560, height: 2560}
            ]),
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        let at = 16;
        stack.driver.tick(at);
        // The paint starts a delayed transition: the base stays computed.
        host.computedStyle['background-image'] = 'url("http://localhost/base-640.jpg") !important';
        state.running = listed;
        stack.images[0].succeed(1280, 1280);
        await settlePromises();
        stack.driver.tick(at += 16);
        assert.strictEqual(host.style.getPropertyValue('background-image'),
            'url("' + url('up-1280.jpg') + '")', 'precondition: the first paint commits');
        stack.driver.tick(at += 16);
        host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
        stack.window.fireEvent('resize');
        stack.driver.tick(at += 16);
        if (stack.images.length < 2) {
            return {stack: stack, host: host, second: false};
        }
        stack.images[1].succeed(1920, 1920);
        await settlePromises();
        stack.driver.tick(at += 16); // the second paint, still inside the delay
        stack.driver.tick(at += 16); // its verification reads the base
        stack.driver.tick(at += 16);
        const pending = stack.driver.pending();
        state.running = false;
        host.computedStyle['background-image'] = 'url("http://localhost/up-1920.jpg")';
        stack.driver.tick(at += 16);
        host.rect = {top: 0, bottom: 700, left: 0, right: 2400, width: 2400, height: 700};
        stack.window.fireEvent('resize');
        stack.driver.tick(at += 16);
        return {stack: stack, host: host, second: true, pending: pending};
    };
    const kept = await run('background-image');
    assert.ok(kept.second, 'the first paint lost its claim inside the delay');
    assert.strictEqual(kept.pending, 1, 'a claim behind a listed transition was not verified again');
    assert.strictEqual(kept.host.style.getPropertyValue('background-image'), 'url("' + url('up-1920.jpg') + '")',
        'a listed transition reverted the chained paint');
    assert.strictEqual(kept.stack.images.length, 3, 'the chained paints cost the host its claim');
    assert.strictEqual(kept.stack.images[2].src, url('up-2560.jpg'));

    for (const listed of [false, 'opacity']) {
        const refused = await run(listed);
        assert.strictEqual(refused.stack.images.length, refused.second ? 2 : 1,
            'a lagging value with no background-image transition listed kept the claim: ' + listed);
    }
}

// An img carrying sizes alone is natively governed and passed over.
function sizesOnlyImgIsSkipped() {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        elementAttributes: {sizes: '50vw'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0);
    assert.strictEqual(stack.reported.length, 0);
}

test(foreignSrcWriteIsNoticedWhenItHappens);
test(aBaseUrlMoveIsNotAForeignWrite);
test(lazyImgDefersItsUpgradeUntilNear);
test(decodedSizeMustMatchTheDescriptor);
test(hiddenDecodeRefusalIsRetriedOnce);
test(aDetachedBackgroundHostKeepsTheClaim);
test(aLazyImgOffToTheSideIsNotNear);
test(combinedContainerTypeIsObserved);
test(aBackgroundTransitionKeepsTheClaim);
test(aPermanentCrossFadeStopsVerifyingAfterTheBound);
test(aBackgroundCommitIsVerifiedOnce);
test(aTransitionedPredecessorKeepsTheClaim);
test(aTransitionedPredecessorLapsesAtTheBound);
test(aListedTransitionKeepsChainedPaints);
test(sizesOnlyImgIsSkipped);

test('a nested scroller reveals and sharpens its lazy image without window input', async () => {
    const scroller = new Element('div', 'scroller');
    const {stack, host} = standaloneHost({parent: scroller,
        elementAttributes: {loading: 'lazy'},
        rect: {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0);
    host.rect = {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700};
    scroller.fireEvent('scroll');
    stack.driver.tick(32);
    assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')]);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    scroller.fireEvent('scroll');
    assert.strictEqual(stack.driver.pending(), 0, 'no frame after the last lazy host is admitted');
});

// Layout can carry a lazy img near with no scroll anywhere — content
// above it collapsing, a sibling removed. The proximity observer, one
// viewport of margin, probes it then; the admitted host leaves it.
test('a lazy image moved near by layout alone upgrades through proximity', async () => {
    FakeSubscription.reset();
    const {observers, IntersectionObserver} = require('./fakes.cjs').intersectionObserverRegistry();
    const {stack, host} = standaloneHost({
        window: {IntersectionObserver},
        elementAttributes: {loading: 'lazy'},
        rect: {top: 6000, bottom: 6700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'a far lazy img fetched');
    assert.strictEqual(observers.length, 1, 'one proximity observer');
    assert.strictEqual(observers[0].options.rootMargin, '100%', 'the margin is one viewport');
    assert.deepStrictEqual(observers[0].observed, [host], 'the deferred host is watched');
    host.rect = {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700};
    observers[0].trigger([{target: host, isIntersecting: true}]);
    await settlePromises();
    stack.driver.tick(32);
    assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')],
        'a lazy img layout carried near was not admitted');
    assert.deepStrictEqual(observers[0].observed, [], 'an admitted host is still watched');
    // A queued report for an already-admitted host schedules nothing.
    observers[0].callback([{target: host, isIntersecting: true}]);
    assert.strictEqual(stack.driver.pending(), 0);
});

test('a refused proximity observer leaves the scroll inputs in charge', () => {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        window: {IntersectionObserver: function () { throw new Error('refused'); }},
        elementAttributes: {loading: 'lazy'},
        rect: {top: 6000, bottom: 6700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0);
    host.rect = {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700};
    stack.window.fireEvent('scroll');
    stack.driver.tick(32);
    assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')]);
});

for (const outcome of ['loaded', 'network error', 'decode error', 'throwing then']) {
    test('preparation releases both native listeners after ' + outcome, async () => {
        FakeSubscription.reset();
        const {stack, host} = standaloneHost({
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        assert.equal(stack.images.length, 1, 'the upgrade must start');
        const image = stack.images[0];
        const subscriptions = FakeSubscription.registry.filter(subscription => subscription.target === image);
        assert.equal(subscriptions.length, 2);
        assert.ok(subscriptions.every(subscription => subscription.isBound()));
        if (outcome === 'network error') image.fail();
        else {
            if (outcome === 'decode error') image.decodeShouldFail = true;
            if (outcome === 'throwing then') image.decode = () => ({then() { throw new Error('decode then refused'); }});
            image.succeed(1280, 1280);
        }
        await settlePromises();
        stack.driver.tick(32);
        assert.ok(subscriptions.every(subscription => !subscription.isBound()), 'a completed preparation retained its listeners');
        assert.equal(shown(host), outcome === 'loaded' ? url('up-1280.jpg') : 'base-640.jpg');
        image.succeed(1280, 1280);
        image.fail();
        await settlePromises();
        stack.driver.tick(48);
        assert.equal(shown(host), outcome === 'loaded' ? url('up-1280.jpg') : 'base-640.jpg', 'a late terminal event changed the settled result');
    });
}

for (const sample of [
    {name: 'missing descriptor', reference: '#absent', message: /references a missing element: absent/},
    {name: 'non-script descriptor', tag: 'div', message: /must reference a script\[type="application\/json"\] element/},
    {name: 'src on a background host', hostTag: 'div', property: 'src', message: /data-image-property src requires an img host/},
    {name: 'invalid base URL', descriptor: {src: 'http://[', width: 640, height: 640}, message: /data-image-sources src cannot be resolved/},
    {name: 'invalid upgrade URL', descriptor: descriptorDocument(640, [{src: 'http://[', width: 1280, height: 1280}]), message: /upgrades\[0\] src cannot be resolved/}
]) {
    test('resolution reports ' + sample.name + ' without blocking a valid sibling', () => {
        FakeSubscription.reset();
        const invalid = new Element(sample.hostTag || 'img', 'invalid');
        invalid.src = 'base-640.jpg';
        invalid.setAttribute('data-paste-progressiveresolution', '');
        invalid.setAttribute('data-image-sources', sample.reference || '#invalid-desc');
        if (sample.property) invalid.setAttribute('data-image-property', sample.property);
        const desc = new Element(sample.tag || 'script', 'invalid-desc');
        desc.setAttribute('type', 'application/json');
        desc.textContent = JSON.stringify(sample.descriptor || descriptorDocument(640));
        const {stack} = standaloneHost({
            elements: {invalid, 'invalid-desc': desc},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        assert.equal(stack.reported.length, 1);
        assert.match(stack.reported[0].message, sample.message);
        assert.equal(stack.images.length, 1, 'the valid sibling must still request its upgrade');
    });
}

test('a smaller later demand neither fetches nor paints a downgrade', async () => {
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images[0].src, url('up-1920.jpg'));
    stack.images[0].succeed(1920, 1920);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(shown(host), url('up-1920.jpg'));
    host.rect.width = 1000;
    host.rect.right = 1000;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.equal(stack.images.length, 1);
    assert.equal(shown(host), url('up-1920.jpg'));
});

for (const refusal of ['throws', 'non-promise', 'throwing then']) {
    test('a hidden ' + refusal + ' decode refusal is retried on visibility return', async () => {
        const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
        stack.driver.tick(16);
        stack.document.hidden = true;
        stack.images[0].decode = () => {
            if (refusal === 'throws') throw new Error('decode refused');
            if (refusal === 'non-promise') return 42;
            return {then() { throw new Error('then refused'); }};
        };
        stack.images[0].succeed(1280, 1280);
        await settlePromises();
        stack.document.hidden = false;
        stack.document.fireEvent('visibilitychange');
        stack.driver.tick(32);
        assert.deepEqual(stack.images.map(image => image.src), [url('up-1280.jpg'), url('up-1280.jpg')]);
        stack.images[1].succeed(1280, 1280);
        await settlePromises();
        stack.driver.tick(48);
        assert.equal(shown(host), url('up-1280.jpg'));
    });
}

test('a shared lazy ancestor receives one scroll subscription for multiple hosts', () => {
    const parent = new Element('div', 'parent');
    const sibling = new Element('img', 'sibling');
    sibling.src = 'base-640.jpg';
    sibling.setAttribute('data-paste-progressiveresolution', '');
    sibling.setAttribute('data-image-sources', '#desc');
    sibling.setAttribute('loading', 'lazy');
    sibling.rect = {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700};
    parent.appendChild(sibling);
    const {stack} = standaloneHost({parent, elementAttributes: {loading: 'lazy'},
        rect: {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 0);
    assert.equal(FakeSubscription.registry.filter(subscription => subscription.target === parent && subscription.name === 'scroll').length, 1);
    assert.equal(FakeSubscription.registry.filter(subscription => subscription.target === stack.window && subscription.name === 'scroll').length, 1);
});

test('a failed resize-observer constructor is not retried for every resolution host', () => {
    const sibling = new Element('img', 'sibling');
    sibling.src = 'base-640.jpg';
    sibling.setAttribute('data-paste-progressiveresolution', '');
    sibling.setAttribute('data-image-sources', '#desc');
    let attempts = 0;
    const {stack} = standaloneHost({elements: {sibling}, window: {
        ResizeObserver: function () { attempts += 1; throw new Error('unavailable'); }
    }});
    stack.driver.tick(16);
    assert.equal(attempts, 1);
    assert.equal(stack.reported.length, 0);
});

test('a foreign image attribute write is noticed through the shared mutation observer', async () => {
    const mutations = fakes.mutationObserverRegistry();
    const {stack, host} = standaloneHost({window: {MutationObserver: mutations.MutationObserver},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    await Promise.resolve();
    assert.equal(host.hasAttribute('srcset'), true);
    host.setAttribute('src', 'foreign.jpg');
    await Promise.resolve();
    assert.equal(stack.driver.pending(), 1, 'the attribute observation did not schedule ownership reconciliation');
    stack.driver.tick(48);
    assert.equal(host.getAttribute('srcset'), null);
    assert.equal(host.getAttribute('sizes'), null);
    assert.equal(host.getAttribute('src'), 'foreign.jpg');
});

for (const attribute of ['srcset', 'sizes']) {
    test('native ' + attribute + ' ownership binds no enhancement inputs', () => {
        FakeSubscription.reset();
        const {stack, host} = standaloneHost({elementAttributes: {[attribute]: attribute === 'sizes' ? '50vw' : 'native.jpg 2x'},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
        stack.driver.tick(16);
        assert.equal(stack.images.length, 0);
        assert.equal(stack.resizeObservers.length, 0);
        assert.equal(FakeSubscription.registry.length, 0);
        assert.ok(host.hasAttribute(attribute));
    });
}

test('all hosts sharing a CSS container re-read its changed resolution cap', () => {
    const parent = new Element('div', 'container');
    parent.computedStyle = {'container-type': 'inline-size', '--paste-resolution-max-width': '640'};
    const sibling = new Element('img', 'sibling');
    sibling.src = 'base-640.jpg';
    sibling.setAttribute('data-paste-progressiveresolution', '');
    sibling.setAttribute('data-image-sources', '#desc');
    sibling.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    parent.appendChild(sibling);
    const {stack} = standaloneHost({parent,
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 0);
    parent.computedStyle['--paste-resolution-max-width'] = '1280';
    stack.resizeObservers[0].trigger(parent);
    stack.driver.tick(32);
    assert.equal(stack.images.length, 2, 'both members must receive the container resize');
});

test('a preparation src setter refusal cannot publish an unrequested image', async () => {
    const preparations = [];
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        window: {Image: function () {
            const image = new Element('img');
            image.naturalWidth = image.naturalHeight = 0;
            Object.defineProperty(image, 'src', {set() { throw new Error('request refused'); }});
            preparations.push(image);
            return image;
        }}});
    stack.driver.tick(16);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(preparations.length, 1);
    assert.ok(FakeSubscription.registry.filter(s => s.target === preparations[0]).every(s => !s.isBound()));
    assert.equal(shown(host), 'base-640.jpg');
    assert.equal(host.hasAttribute('sizes'), false);
});

test('a refused background paint permanently stops optional admissions for that host', async () => {
    const host = new Element('div', 'host');
    host.computedStyle = {'background-image': 'url("base-640.jpg")', 'background-size': 'cover'};
    const {stack} = standaloneHost({host, imageProperty: 'background-image',
        rect: {top: 0, bottom: 1000, left: 0, right: 1000, width: 1000, height: 1000},
        computedStyle: host.computedStyle});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 1);
    host.style.setProperty = () => { throw new Error('paint refused'); };
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    host.rect.width = host.rect.height = 1800;
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.equal(stack.images.length, 1);
    assert.equal(host.style.getPropertyValue('background-image'), '');
});

test('an img upgrade changes only its image candidate attributes', async () => {
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(shown(host), url('up-1280.jpg'));
    assert.equal(host.style.getPropertyValue('background-image'), '');
});

// A detached host computes an empty value for every property in every
// engine — the CSSOM's answer for an element outside the document —
// whatever connection surface it offers, while its inline declaration
// stays the module's. That empty value is no evidence against the
// claim: reattached and grown, the host keeps upgrading.
for (const legacy of [false, true]) {
    test('a detached background keeps ownership with legacy connection detection ' + legacy, async () => {
        const host = new Element('div', 'host');
        if (legacy) Object.defineProperty(host, 'isConnected', {value: undefined});
        let detached = false;
        const {stack} = standaloneHost({host,
            window: {getComputedStyle: element => ({getPropertyValue: name => {
                if (element === host && detached) return '';
                return element.style.getPropertyValue(name) || String((element.computedStyle || {})[name] || '');
            }})},
            computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
        stack.driver.tick(16);
        stack.images[0].succeed(1280, 1280);
        await settlePromises();
        stack.driver.tick(32);
        const parent = host.parentNode;
        parent.removeChild(host);
        detached = true;
        stack.window.fireEvent('resize');
        stack.driver.tick(48);
        assert.strictEqual(stack.driver.pending(), 0, 'an unread claim kept the frames running');
        parent.appendChild(host);
        detached = false;
        host.rect = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
        stack.window.fireEvent('resize');
        stack.driver.tick(64);
        assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg'), url('up-1920.jpg')],
            'a detached host stood down');
    });
}

test('an empty computed background is no evidence against an existing claim', async () => {
    let unread = false;
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({host, computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        window: {getComputedStyle(element) {
            const style = predecessorStyle(element);
            return {getPropertyValue: name => unread && name === 'background-image' ? '' : style.getPropertyValue(name)};
        }}});
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    unread = true;
    stack.driver.tick(48);
    unread = false;
    host.rect.width = 1800;
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.equal(stack.images.length, 2);
});

test('a transition toward a foreign gradient relinquishes the background claim', async () => {
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({host, computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
        'transition-property': 'background-image', 'transition-duration': '1s'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700},
        window: {getComputedStyle: predecessorStyle}});
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    host.computedStyle['background-image'] = 'linear-gradient(red, blue) !important';
    stack.driver.tick(48);
    delete host.computedStyle['background-image'];
    host.rect.width = 1800;
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.equal(stack.images.length, 1);
});

test('a fresh background upgrade starts a new verification interval after an older one lapsed', async () => {
    const host = new Element('div', 'host');
    const {stack} = standaloneHost({host, computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    host.computedStyle['background-image'] = 'cross-fade(url("http://localhost/base-640.jpg"), url("http://localhost/up-1280.jpg")) !important';
    stack.driver.tick(48);
    stack.driver.tick(5100);
    assert.equal(stack.driver.pending(), 0);
    host.rect.width = 1800;
    stack.window.fireEvent('resize');
    stack.driver.tick(5116);
    stack.images[1].succeed(1920, 1920);
    await settlePromises();
    stack.driver.tick(5132);
    host.computedStyle['background-image'] = 'cross-fade(url("http://localhost/up-1280.jpg"), url("http://localhost/up-1920.jpg")) !important';
    stack.driver.tick(5148);
    assert.equal(stack.driver.pending(), 1);
    stack.driver.tick(5200);
    assert.equal(stack.driver.pending(), 1);
    delete host.computedStyle['background-image'];
    stack.driver.tick(5216);
    assert.equal(stack.driver.pending(), 0);
    assert.equal(host.style.getPropertyValue('background-image'), 'url("http://localhost/up-1920.jpg")');
});

test('verification work from an earlier host is scheduled even when the final host needs none', async () => {
    const host = new Element('div', 'host'), sibling = new Element('img', 'sibling');
    sibling.src = 'base-640.jpg';
    sibling.setAttribute('data-paste-progressiveresolution', '');
    sibling.setAttribute('data-image-sources', '#desc');
    const {stack} = standaloneHost({host, elements: {sibling},
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 1);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(stack.driver.pending(), 1);
    stack.driver.tick(48);
    assert.equal(stack.driver.pending(), 0);
});

test('a withheld preferred rung falls back without retrying while hidden', async () => {
    const {stack, host} = standaloneHost({rect: {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images[0].src, url('up-1920.jpg'));
    stack.document.hidden = true;
    stack.images[0].decodeShouldFail = true;
    stack.images[0].succeed(1920, 1920);
    await settlePromises();
    stack.driver.tick(32);
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.deepEqual(stack.images.map(image => image.src), [url('up-1920.jpg'), url('up-1280.jpg')]);
    stack.images[1].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(64);
    assert.equal(shown(host), url('up-1280.jpg'));
});

test('a host without URL construction can still sharpen matching literal sources', async () => {
    const {stack, host} = standaloneHost({window: {URL: null},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}});
    stack.driver.tick(16);
    assert.equal(stack.images.length, 1);
    stack.images[0].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(32);
    assert.equal(shown(host), 'up-1280.jpg');
});

// A vector source has no pixel size to contradict its descriptor: the
// engine reports its own default box for a viewBox-only image, and the
// rung still commits. A raster rung is still held to its size.
test('a vector rung commits whatever natural size the engine reports', async () => {
    for (const vector of ['up-1280.svg', 'up-1280.SVGZ?v=2', 'up-1280.svg#view',
        'data:image/svg+xml;utf8,<svg/>']) {
        FakeSubscription.reset();
        const {stack, host} = standaloneHost({
            descriptor: descriptorDocument(640, [{src: vector, width: 1280, height: 1280}]),
            rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
        });
        stack.driver.tick(16);
        assert.strictEqual(stack.images.length, 1, vector + ' was not prepared');
        stack.images[0].succeed(300, 150);
        await settlePromises();
        stack.driver.tick(32);
        assert.strictEqual(shown(host), new URL(vector, 'http://localhost/').href, vector + ' was refused');
    }
    FakeSubscription.reset();
    const raster = standaloneHost({
        descriptor: descriptorDocument(640, [{src: 'up-1280.svg.png', width: 1280, height: 1280}]),
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    raster.stack.driver.tick(16);
    raster.stack.images[0].succeed(300, 150);
    await settlePromises();
    raster.stack.driver.tick(32);
    assert.strictEqual(shown(raster.host), 'base-640.jpg', 'a mis-sized raster rung committed');
});

// The need is the box the image is sized against: an img's content
// box, inside padding and border — a 600px image with 100px padding
// and a 25px border is a 600px need, not 850.
test('an img need excludes its padding and border', () => {
    FakeSubscription.reset();
    const {stack} = standaloneHost({
        computedStyle: {'padding-left': '100px', 'padding-right': '100px', 'padding-top': '100px',
            'padding-bottom': '100px', 'border-left-width': '25px', 'border-right-width': '25px',
            'border-top-width': '25px', 'border-bottom-width': '25px'},
        rect: {top: 0, bottom: 850, left: 0, right: 850, width: 850, height: 850}
    });
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'the border box asked for an upgrade');
});

// A background is sized against its positioning area: the padding box
// by default, the content box or border box when background-origin
// names it, and the viewport for a fixed attachment.
test('a background need follows its positioning area', () => {
    // A 1400px border box: a 1000px padding box, a 400px content box.
    const insets = {'padding-left': '300px', 'padding-right': '300px', 'padding-top': '300px',
        'padding-bottom': '300px', 'border-left-width': '200px', 'border-right-width': '200px',
        'border-top-width': '200px', 'border-bottom-width': '200px'};
    for (const sample of [
        {origin: '', expected: [url('up-1280.jpg')]},
        {origin: 'padding-box, content-box', expected: [url('up-1280.jpg')]},
        {origin: 'content-box', expected: []},
        {origin: 'border-box', expected: [url('up-1920.jpg')]}
    ]) {
        FakeSubscription.reset();
        const {stack} = standaloneHost({
            host: new Element('div', 'host'),
            computedStyle: Object.assign({'background-image': 'url("http://localhost/base-640.jpg")',
                'background-size': 'cover', 'background-origin': sample.origin}, insets),
            rect: {top: 0, bottom: 1400, left: 0, right: 1400, width: 1400, height: 1400}
        });
        stack.driver.tick(16);
        assert.deepStrictEqual(stack.images.map(image => image.src), sample.expected,
            'background-origin ' + JSON.stringify(sample.origin));
    }
    // Fixed: the 600x800 viewport, not the 100x50 element box, is covered.
    for (const attachment of ['scroll', 'fixed']) {
        FakeSubscription.reset();
        const {stack} = standaloneHost({
            host: new Element('div', 'host'),
            computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
                'background-size': 'cover', 'background-attachment': attachment},
            rect: {top: 0, bottom: 50, left: 0, right: 100, width: 100, height: 50}
        });
        stack.driver.tick(16);
        assert.deepStrictEqual(stack.images.map(image => image.src),
            attachment === 'fixed' ? [url('up-1280.jpg')] : [], 'background-attachment ' + attachment);
    }
    // A fixed background on a host with no box paints nothing.
    FakeSubscription.reset();
    const hidden = standaloneHost({
        host: new Element('div', 'host'),
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
            'background-size': 'cover', 'background-attachment': 'fixed'},
        rect: {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0}
    });
    hidden.stack.driver.tick(16);
    assert.strictEqual(hidden.stack.images.length, 0, 'an unrendered fixed background asked for an upgrade');
});

// The retry visibility grants is spent only by a preparation of the
// withheld URL in the pass that follows. A pass that selects another
// rung releases it, and a later hidden refusal of that URL is withheld
// again, not final.
test('a hidden retry the visible pass does not use is not spent', async () => {
    FakeSubscription.reset();
    const wide = {top: 0, bottom: 700, left: 0, right: 1800, width: 1800, height: 700};
    const {stack, host} = standaloneHost({rect: wide});
    stack.driver.tick(16);
    assert.strictEqual(stack.images[0].src, url('up-1920.jpg'));
    stack.document.hidden = true;
    stack.images[0].decodeShouldFail = true;
    stack.images[0].succeed(1920, 1920);
    await settlePromises();
    host.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(32);
    assert.strictEqual(stack.images[1].src, url('up-1280.jpg'), 'the visible pass selects the smaller rung');
    stack.images[1].succeed(1280, 1280);
    await settlePromises();
    stack.driver.tick(48);
    assert.strictEqual(shown(host), url('up-1280.jpg'));
    host.rect = wide;
    stack.window.fireEvent('resize');
    stack.driver.tick(64);
    assert.strictEqual(stack.images[2].src, url('up-1920.jpg'), 'the released rung is selectable again');
    stack.document.hidden = true;
    stack.images[2].decodeShouldFail = true;
    stack.images[2].succeed(1920, 1920);
    await settlePromises();
    stack.document.hidden = false;
    stack.document.fireEvent('visibilitychange');
    stack.driver.tick(80);
    assert.deepStrictEqual(stack.images.map(image => image.src),
        [url('up-1920.jpg'), url('up-1280.jpg'), url('up-1920.jpg'), url('up-1920.jpg')],
        'a refusal after a released retry was final');
    stack.images[3].succeed(1920, 1920);
    await settlePromises();
    stack.driver.tick(96);
    assert.strictEqual(shown(host), url('up-1920.jpg'));
});

// A lazy host that stands down leaves the deferred list: scrolling
// arms no pass for it again.
test('a stood-down lazy host arms no pass on scroll', () => {
    FakeSubscription.reset();
    const {stack, host} = standaloneHost({
        elementAttributes: {loading: 'lazy'},
        rect: {top: 3000, bottom: 3700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    host.src = 'https://cdn.other.example/next-slide.jpg';
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.driver.pending(), 0);
    stack.window.fireEvent('scroll');
    assert.strictEqual(stack.driver.pending(), 0, 'a scroll armed a pass for a stood-down host');
    host.rect = {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700};
    stack.window.fireEvent('scroll');
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'a stood-down host fetched');
});

// Where the proximity observer watches a lazy host, its verdict alone
// is nearness: nothing is admitted before its first report, a host it
// reports outside the margin stays deferred however near its box looks
// against the window's own viewport (a frame's viewport, or a clipping
// ancestor's hidden overflow), and no scroll input is subscribed.
test('the proximity verdict decides nearness for a watched lazy host', async () => {
    FakeSubscription.reset();
    const {observers, IntersectionObserver} = require('./fakes.cjs').intersectionObserverRegistry();
    const scroller = new Element('div', 'scroller');
    const {stack, host} = standaloneHost({
        window: {IntersectionObserver},
        parent: scroller,
        elementAttributes: {loading: 'lazy'},
        rect: {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700}
    });
    assert.strictEqual(FakeSubscription.registry.filter(subscription => subscription.name === 'scroll').length, 0,
        'a watched host subscribed scroll');
    stack.driver.tick(16);
    assert.strictEqual(stack.images.length, 0, 'admitted before the first report');
    observers[0].trigger([{target: host, isIntersecting: false}]);
    await settlePromises();
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.strictEqual(stack.images.length, 0, 'a host reported outside the margin was admitted');
    // Reports arrive in time order: the last one for a host stands.
    observers[0].trigger([{target: host, isIntersecting: true}, {target: host, isIntersecting: false}]);
    await settlePromises();
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    assert.strictEqual(stack.images.length, 0, 'an earlier entry outranked the latest');
    observers[0].trigger([{target: host, isIntersecting: true}]);
    await settlePromises();
    stack.driver.tick(64);
    assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')]);
});

// A fixed background is sized for at least the viewport, even under a
// transform on its host or an ancestor, where engines paint it as
// scroll: a larger fetch, never a blurrier image — and no transform
// that comes or goes later can leave it short. In quirks mode neither
// the root element nor the body reliably reports the viewport, so the
// window's inner size does.
test('a fixed background is sized for the viewport whatever transforms it', () => {
    const fixedStyle = {'background-image': 'url("http://localhost/base-640.jpg")',
        'background-size': 'cover', 'background-attachment': 'fixed'};
    const small = {top: 0, bottom: 50, left: 0, right: 100, width: 100, height: 50};
    for (const sample of [
        {self: {transform: 'matrix(1, 0, 0, 1, 0, 0)'}},
        {self: {'will-change': 'transform'}},
        {ancestor: {scale: '1'}},
        {ancestor: {transform: 'none'}}
    ]) {
        FakeSubscription.reset();
        const wrapper = new Element('div', 'wrapper');
        wrapper.computedStyle = sample.ancestor || {};
        const {stack} = standaloneHost({
            host: new Element('div', 'host'),
            parent: wrapper,
            computedStyle: Object.assign({}, fixedStyle, sample.self || {}),
            rect: small
        });
        stack.driver.tick(16);
        assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')],
            'a fixed background under ' + JSON.stringify(sample));
    }
    // Quirks mode: the root element reports its own 5000px box and the
    // body its own 1180x3240 one; the 600x800 window covers at 1280,
    // not the 1920 either box would ask for.
    FakeSubscription.reset();
    const quirks = standaloneHost({
        host: new Element('div', 'host'),
        document: {compatMode: 'BackCompat'},
        computedStyle: fixedStyle,
        rect: small
    });
    quirks.stack.document.documentElement.clientHeight = 5000;
    quirks.stack.document.body.clientWidth = 1180;
    quirks.stack.document.body.clientHeight = 3240;
    quirks.stack.driver.tick(16);
    assert.deepStrictEqual(quirks.stack.images.map(image => image.src), [url('up-1280.jpg')],
        'quirks mode sized a fixed background against an element box');
});

// A fixed background that paints as scroll — under a transform, or in a
// browser that ignores fixed — covers its own padding box, which can be
// larger than the viewport in either dimension. The need is the larger
// of the two boxes per dimension: a 300x1500 host on the 600x800
// viewport covers at 1500, a 1400x200 one at 1400 — 1920 for both, where
// the viewport alone would ask for 1280. A host inside the viewport
// keeps the viewport's need.
test('a fixed background larger than the viewport is sized for its own box too', () => {
    const fixedStyle = {'background-image': 'url("http://localhost/base-640.jpg")',
        'background-size': 'cover', 'background-attachment': 'fixed', transform: 'matrix(1, 0, 0, 1, 0, 0)'};
    for (const sample of [
        {rect: {top: 0, bottom: 1500, left: 0, right: 300, width: 300, height: 1500}, expected: 'up-1920.jpg'},
        {rect: {top: 0, bottom: 200, left: 0, right: 1400, width: 1400, height: 200}, expected: 'up-1920.jpg'},
        {rect: {top: 0, bottom: 700, left: 0, right: 500, width: 500, height: 700}, expected: 'up-1280.jpg'}
    ]) {
        FakeSubscription.reset();
        const {stack} = standaloneHost({
            host: new Element('div', 'host'),
            computedStyle: fixedStyle,
            rect: sample.rect
        });
        stack.driver.tick(16);
        assert.deepStrictEqual(stack.images.map(image => image.src), [url(sample.expected)],
            'a fixed background on a ' + sample.rect.width + 'x' + sample.rect.height + ' host');
    }
});

// A 'local' background on a scroll container is sized against its whole
// scrollable content, not the visible box: 300x200 visible over 2000px
// of content covers at 2000/640 of the base height.
test('a local background on a scroll container follows its scrollable content', () => {
    for (const sample of [
        {overflow: 'auto', attachment: 'local', expected: [url('up-1920.jpg')]},
        {overflow: 'visible', attachment: 'local', expected: []},
        {overflow: 'auto', attachment: 'scroll', expected: []}
    ]) {
        FakeSubscription.reset();
        const host = new Element('div', 'host');
        host.scrollWidth = 300;
        host.scrollHeight = 2000;
        host.clientWidth = 300;
        host.clientHeight = 200;
        host.offsetWidth = 300;
        host.offsetHeight = 200;
        const {stack} = standaloneHost({
            host: host,
            computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
                'background-size': 'cover', 'background-attachment': sample.attachment,
                'overflow-x': sample.overflow},
            rect: {top: 0, bottom: 200, left: 0, right: 300, width: 300, height: 200}
        });
        stack.driver.tick(16);
        assert.deepStrictEqual(stack.images.map(image => image.src), sample.expected, JSON.stringify(sample));
    }
    // A box overflow does not apply to — an inline box — reports no
    // client or scrollable size: its own 1000x700 box is the need.
    FakeSubscription.reset();
    const inline = new Element('span', 'host');
    inline.scrollWidth = 0;
    inline.scrollHeight = 0;
    inline.clientWidth = 0;
    inline.clientHeight = 0;
    const {stack} = standaloneHost({
        host: inline,
        computedStyle: {'background-image': 'url("http://localhost/base-640.jpg")',
            'background-size': 'cover', 'background-attachment': 'local', 'overflow-x': 'auto'},
        rect: {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700}
    });
    stack.driver.tick(16);
    assert.deepStrictEqual(stack.images.map(image => image.src), [url('up-1280.jpg')],
        'an inline local background lost its origin box');
});

test('a pending or deferred upgrade does not select another candidate', () => {
    for (const lazy of [false, true]) {
        let selections = 0;
        const {stack} = standaloneHost({
            elementAttributes: lazy ? {loading: 'lazy'} : {},
            rect: {top: lazy ? 10000 : 0, bottom: lazy ? 11000 : 1000,
                left: 0, right: 1000, width: 1000, height: 1000},
            beforeElements(modules) {
                const select = modules.imageresolution.selectCandidate;
                modules.imageresolution.selectCandidate = function () {
                    selections++;
                    return select.apply(this, arguments);
                };
            }
        });
        stack.driver.tick(16);
        assert.equal(stack.images.length, lazy ? 0 : 1);
        const admitted = selections;
        stack.window.fireEvent('resize');
        stack.driver.tick(32);
        assert.equal(selections, admitted, 'an ineligible host selected again');
        if (lazy) assert.equal(selections, 0);
    }
});

test('a base-only descriptor binds no observers, listeners or frame work', () => {
    FakeSubscription.reset();
    const {observers, IntersectionObserver} = fakes.intersectionObserverRegistry();
    const {stack} = standaloneHost({descriptor: descriptorDocument(640),
        window: {IntersectionObserver}, elementAttributes: {loading: 'lazy'}});
    assert.equal(stack.driver.pending(), 0);
    assert.equal(FakeSubscription.registry.length, 0);
    assert.equal(observers.length, 0);
    assert.equal(stack.images.length, 0);
});

test('an observer-deferred lazy image reads no computed policy or rectangle', () => {
    FakeSubscription.reset();
    const {observers, IntersectionObserver} = fakes.intersectionObserverRegistry();
    const {stack, host} = standaloneHost({window: {IntersectionObserver}, elementAttributes: {loading: 'lazy'}});
    let rectangles = 0, styles = 0;
    const rect = host.getBoundingClientRect;
    host.getBoundingClientRect = function () { rectangles += 1; return rect.call(this); };
    const style = stack.window.getComputedStyle;
    stack.window.getComputedStyle = function () { styles += 1; return style.apply(this, arguments); };
    stack.driver.tick(16);
    observers[0].trigger([{target: host, isIntersecting: false}]);
    stack.window.fireEvent('resize');
    stack.driver.tick(32);
    assert.equal(rectangles, 0);
    assert.equal(styles, 0);
    assert.equal(stack.images.length, 0);
    // A foreign source still retires ownership while the image is deferred.
    host.setAttribute('srcset', 'foreign.jpg 2x');
    stack.window.fireEvent('resize');
    stack.driver.tick(48);
    observers[0].trigger([{target: host, isIntersecting: true}]);
    stack.driver.tick(64);
    assert.equal(stack.images.length, 0);
    assert.equal(host.getAttribute('srcset'), 'foreign.jpg 2x');
});

test('a resize delivery for an unwatched box schedules no work', () => {
    const {stack} = standaloneHost(); stack.driver.tick(16);
    stack.resizeObservers[0].callback([{target: new Element('div', 'unwatched')}]);
    assert.equal(stack.driver.pending(), 0);
});

for (const weak of [WeakMap, undefined, function RefusedWeakMap() { throw new Error('unavailable'); }]) {
    test('proximity lookup preserves ordering and ignores admitted/unknown hosts: ' + (weak ? weak.name : 'absent'), async () => {
        FakeSubscription.reset();
        const {observers, IntersectionObserver} = require('./fakes.cjs').intersectionObserverRegistry();
        const {stack, host} = standaloneHost({window: {IntersectionObserver, WeakMap: weak},
            elementAttributes: {loading: 'lazy'},
            rect: {top: 100, bottom: 800, left: 0, right: 1000, width: 1000, height: 700}});
        stack.driver.tick(16);
        const stranger = new Element('img', 'unknown');
        observers[0].trigger([{target: stranger, isIntersecting: true},
            {target: host, isIntersecting: true}, {target: host, isIntersecting: false}]);
        await settlePromises(); stack.driver.tick(32);
        assert.equal(stack.images.length, 0);
        observers[0].trigger([{target: host, isIntersecting: true}]);
        await settlePromises(); stack.driver.tick(48);
        assert.equal(stack.images.length, 1);
        stack.images[0].succeed(1280, 1280); await settlePromises();
        stack.driver.tick(64); stack.driver.tick(80);
        assert.equal(stack.driver.pending(), 0);
        observers[0].trigger([{target: host, isIntersecting: true}, {target: stranger, isIntersecting: true}]);
        await settlePromises();
        assert.equal(stack.driver.pending(), 0);
        assert.equal(stack.images.length, 1);
    });
}
