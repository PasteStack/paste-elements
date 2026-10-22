const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
    Element, FakeSubscription, eventModule, loadModule, matchesSelector,
    openUiStack, readModuleSource, settlePromises
} = require('./fakes.cjs');

// The cross-module frame contract. A scrub, an image sequence on the
// same scope and a hero section share one page and one animation-frame
// module — the real one, over a host requestAnimationFrame the test
// pumps. Every geometry or computed-style read is logged, and so is
// every style, attribute or class write: a read that follows a write
// within one host frame is a forced style/layout, and the shared
// batch's phases must leave none.

// The real animation-frame module over a host whose frames the test
// delivers by hand.
function realFrames() {
    const frames = [];
    let hostId = 0;
    const exports = {};
    const window = {
        requestAnimationFrame: function (cb) {
            hostId += 1;
            frames.push({id: hostId, cb: cb});
            return hostId;
        },
        cancelAnimationFrame: function (id) {
            const index = frames.findIndex(frame => frame.id === id);
            if (index >= 0) {
                frames.splice(index, 1);
            }
        },
        performance: {now: () => 0}
    };
    vm.runInNewContext(readModuleSource('paste/ui/utilities/animation-frame.js'), {
        window, setTimeout, isFinite, Object, Date,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.utilities.animation-frame');
            factory(exports);
        }}
    });
    return {
        request: exports.request,
        requestPhased: exports.requestPhased,
        cancel: exports.cancel,
        // One host frame: the whole shared batch.
        tick: time => frames.splice(0).forEach(frame => frame.cb(time)),
        pending: () => frames.length
    };
}

// The page: one scope declaring a scrub and an image sequence, and one
// hero section with a fading image.
function page() {
    const scope = new Element('div', 'scope');
    scope.setAttribute('data-paste-scrollscrub', '');
    const host = new Element('div', 'host');
    host.setAttribute('data-paste-imagesequence', '#frames');
    host.computedStyle = {'background-image': 'url("http://localhost/f0.jpg")'};
    host.rect = {top: 0, left: 0, bottom: 450, right: 800, width: 800, height: 450};
    scope.appendChild(host);
    const frames = [];
    for (let i = 0; i < 10; i += 1) {
        frames.push({src: 'f' + i + '.jpg', width: 800, height: 450});
    }
    const catalog = new Element('script', 'frames');
    catalog.setAttribute('type', 'application/json');
    catalog.textContent = JSON.stringify({frames});
    scope.appendChild(catalog);
    scope.rect = {top: 1600, left: 0, bottom: 1800, right: 100, width: 100, height: 200};

    const hero = new Element('div', 'hero');
    hero.className = 'paste-ui-hero';
    hero.rect = {top: 0, left: 0, bottom: 600, right: 800, width: 800, height: 600};
    const heroImage = new Element('div', 'heroimage');
    heroImage.className = 'paste-ui-hero-image';
    heroImage.setAttribute('data-hero-image-fade', '');
    const heroContent = new Element('div', 'herocontent');
    heroContent.className = 'paste-ui-hero-content';
    heroContent.rect = {top: 100, left: 0, bottom: 300, right: 800, width: 800, height: 200};
    hero.appendChild(heroImage);
    hero.appendChild(heroContent);
    return {scope, host, hero, heroImage, heroContent};
}

// heroscroll's dependencies over the same fake page.
function loadHeroscroll(stack, driver) {
    const doc = stack.document;
    const win = stack.window;
    const classList = () => ({add() {}, remove() {}, contains() { return false; }});
    doc.documentElement.classList = classList();
    doc.body.classList = classList();
    doc.body.style.opacity = '';
    doc.body.style.backgroundSize = '';
    doc.getElementsByTagName = tag => (tag === 'body' ? [doc.body] : []);
    const dom = {
        Bounds: {fromElement: el => {
            if (!el) {
                return {top: 0, height: 0, getBottom() { return 0; }};
            }
            const rect = el.getBoundingClientRect();
            const top = rect.top + win.pageYOffset;
            return {top, height: rect.height, getBottom() { return top + rect.height; }};
        }},
        getDocumentBody: () => doc.documentElement,
        querySelector: (selector, context) => (context || doc).querySelector(selector),
        get: selector => doc.querySelectorAll(selector),
        hasCssClass: (el, name) => matchesSelector(el, '.' + name),
        addCssClass: (el, name) => { el.className += ' ' + name; },
        getScrollTop: () => win.pageYOffset,
        getViewportHeight: () => 800
    };
    const util = {
        stringStartsWith: (text, prefix) => String(text).indexOf(prefix) === 0,
        stringEndsWith: (text, suffix) => String(text).slice(-suffix.length) === suffix
    };
    return loadModule({
        file: 'paste/ui/heroscroll.js',
        name: 'paste.ui.heroscroll',
        deps: ['paste.util', 'paste.dom', 'paste.event', 'paste.has',
            'paste.ui.utilities.animation-frame', 'paste.ui.utilities.mediaquery',
            'polyfills.getcomputedstyle'],
        impls: [util, dom, eventModule, {touch: false}, driver, stack.modules.mediaquery, {}],
        sharedDocument: doc,
        sharedWindow: win
    });
}

// The order log: reads and writes in the sequence the page saw them.
// A read after a write in the same frame is FORCED.
function instrument(stack, elements) {
    const log = [];
    const state = {dirty: false, forced: 0};
    const read = name => {
        if (state.dirty) {
            state.forced += 1;
            log.push('FORCED ' + name);
        } else {
            log.push('read ' + name);
        }
        state.dirty = false;
    };
    const write = name => {
        state.dirty = true;
        log.push('write ' + name);
    };
    elements.forEach(el => {
        const rect = el.getBoundingClientRect.bind(el);
        el.getBoundingClientRect = () => { read('rect#' + el.id); return rect(); };
        const rects = el.getClientRects.bind(el);
        el.getClientRects = () => { read('rects#' + el.id); return rects(); };
        const style = el.style;
        const setProperty = style.setProperty.bind(style);
        style.setProperty = (name, value, priority) => {
            write('#' + el.id + ' ' + name);
            return setProperty(name, value, priority);
        };
        const removeProperty = style.removeProperty.bind(style);
        style.removeProperty = name => {
            write('#' + el.id + ' -' + name);
            return removeProperty(name);
        };
        const setAttribute = el.setAttribute.bind(el);
        el.setAttribute = (name, value) => {
            write('#' + el.id + ' [' + name + ']');
            return setAttribute(name, value);
        };
    });
    const computed = stack.window.getComputedStyle;
    stack.window.getComputedStyle = el => { read('style#' + el.id); return computed(el); };
    const root = stack.document.documentElement;
    const clientHeight = root.clientHeight;
    Object.defineProperty(root, 'clientHeight', {configurable: true, get() {
        read('root.clientHeight');
        return clientHeight;
    }});
    return {
        log,
        state,
        reset: () => {
            log.length = 0;
            state.dirty = false;
            state.forced = 0;
        }
    };
}

function scrollPage(stack, places, offset) {
    stack.window.pageYOffset = offset;
    places.scope.rect = {top: 1600 - offset, left: 0, bottom: 1800 - offset, right: 100,
        width: 100, height: 200};
    places.hero.rect = {top: -offset, left: 0, bottom: 600 - offset, right: 800, width: 800, height: 600};
    places.heroContent.rect = {top: 100 - offset, left: 0, bottom: 300 - offset, right: 800,
        width: 800, height: 200};
    stack.window.fireEvent('scroll');
}

async function openPage() {
    FakeSubscription.reset();
    const driver = realFrames();
    const places = page();
    const stack = openUiStack({
        elements: {scope: places.scope, hero: places.hero},
        scrollscrub: true,
        imagesequence: true,
        frameDriver: driver
    });
    loadHeroscroll(stack, driver);
    const probe = instrument(stack, [places.scope, places.host, places.hero, places.heroImage,
        places.heroContent]);
    let time = 16;
    driver.tick(time);
    stack.images.forEach(image => image.succeed(800, 450));
    await settlePromises();
    await settlePromises();
    return {driver, places, stack, probe, next: () => { time += 16; return time; }};
}

test('the order log flags a read that follows a write in one frame', async () => {
    // The harness's own control: a write, then a geometry read, is
    // reported — the passing tests below are not a blind log.
    const {places, probe} = await openPage();
    probe.reset();
    places.host.style.setProperty('opacity', '0.5');
    places.scope.getBoundingClientRect();
    assert.equal(probe.state.forced, 1, probe.log.join(' | '));
});

test('scrub, image sequence and hero on one page: no read follows a write within a frame', async () => {
    const {driver, places, stack, probe, next} = await openPage();
    let wrote = 0;
    for (let step = 0; step < 6; step += 1) {
        scrollPage(stack, places, 800 + step * 120);
        // Three modules, each with work, share one host frame.
        assert.equal(driver.pending(), 1,
            'step ' + step + ': the modules armed ' + driver.pending() + ' host frames');
        probe.reset();
        driver.tick(next());
        assert.equal(probe.state.forced, 0, 'step ' + step + ': ' + probe.log.join(' | '));
        wrote += probe.log.filter(entry => entry.indexOf('write') === 0).length;
        // The scope is measured once per frame, not once per module.
        assert.ok(probe.log.filter(entry => entry === 'read rect#scope').length <= 1,
            'step ' + step + ': the scope was measured more than once: ' + probe.log.join(' | '));
        stack.images.forEach(image => {
            if (!image.settledByTest) {
                image.settledByTest = true;
                image.succeed(800, 450);
            }
        });
        await settlePromises();
        await settlePromises();
    }
    assert.ok(wrote > 0, 'precondition: the frames wrote nothing, so the order proved nothing');
});

test('a resize re-measures every module in the read phase without a forced read', async () => {
    const {driver, places, stack, probe, next} = await openPage();
    scrollPage(stack, places, 900);
    driver.tick(next());
    await settlePromises();
    stack.window.fireEvent('resize');
    scrollPage(stack, places, 960);
    assert.equal(driver.pending(), 1, 'the resize armed more than one host frame');
    probe.reset();
    driver.tick(next());
    assert.equal(probe.state.forced, 0, probe.log.join(' | '));
    assert.ok(probe.log.indexOf('read rect#hero') >= 0, 'precondition: the hero re-measured');
    assert.ok(probe.log.indexOf('read rect#host') >= 0, 'precondition: the sequence re-read its box');
});

test('each module keeps one armed phased frame through a scroll and resize burst', async () => {
    FakeSubscription.reset();
    const driver = realFrames();
    const armed = [];
    const requestPhased = driver.requestPhased;
    driver.requestPhased = (read, write) => {
        armed.push(read);
        return requestPhased(read, write);
    };
    const request = driver.request;
    let plain = 0;
    driver.request = callback => {
        plain += 1;
        return request(callback);
    };
    const places = page();
    const sharp = new Element('img', 'sharp');
    sharp.src = 'base-640.jpg';
    sharp.setAttribute('width', '640');
    sharp.setAttribute('height', '640');
    sharp.setAttribute('data-paste-progressiveresolution', '');
    sharp.setAttribute('data-image-sources', '#sharpsources');
    sharp.rect = {top: 0, bottom: 700, left: 0, right: 1000, width: 1000, height: 700};
    const sources = new Element('script', 'sharpsources');
    sources.setAttribute('type', 'application/json');
    sources.textContent = JSON.stringify({src: 'base-640.jpg', width: 640, height: 640,
        upgrades: [{src: 'up-1280.jpg', width: 1280, height: 1280}]});
    const stack = openUiStack({
        elements: {scope: places.scope, hero: places.hero, sharp, sharpsources: sources},
        scrollscrub: true,
        imagesequence: true,
        progressiveresolution: true,
        frameDriver: driver
    });
    loadHeroscroll(stack, driver);
    driver.tick(16);
    stack.images.forEach(image => image.succeed(800, 450));
    await settlePromises();
    await settlePromises();
    driver.tick(32);
    armed.length = 0;
    for (let i = 0; i < 20; i += 1) {
        scrollPage(stack, places, 800 + i * 7);
        stack.window.fireEvent('resize');
    }
    const distinct = armed.filter((read, index) => armed.indexOf(read) === index);
    assert.equal(plain, 0, 'a converted module armed a plain frame request');
    assert.equal(distinct.length, 4,
        'expected scrollscrub, imagesequence, progressiveresolution and heroscroll each to arm');
    assert.equal(armed.length, distinct.length,
        'a module armed more than one frame for the burst: ' + armed.length + ' requests');
    assert.equal(driver.pending(), 1, 'the modules did not share one host frame');
});

// The rest of the page's frame users: a sticky nav, a scroll spy and an
// autogrowing field, each over the same document, window and real
// animation-frame module. Every write a module makes is stamped with
// the host frame that made it.
function loadFrameUsers(stack, driver, writes) {
    const doc = stack.document;
    const win = stack.window;
    const stamp = name => { writes.push({module: name, frame: driver.frame()}); };
    // Document coordinates: the fixture's boxes do not move with scroll.
    const bounds = el => ({top: el.docTop, height: el.docHeight});
    const bodyClasses = new Set();
    const body = {classList: {
        add: c => { stamp('stickynav'); bodyClasses.add(c); },
        remove: c => { stamp('stickynav'); bodyClasses.delete(c); },
        contains: c => bodyClasses.has(c)
    }};

    const navWrap = new Element('div', '_paste_ui_nav_wrap');
    navWrap.docTop = 0;
    navWrap.docHeight = 50;
    const stickyParent = new Element('div', 'stickyparent');
    stickyParent.docTop = 0;
    stickyParent.docHeight = 2000;
    const above = new Element('div', 'above');
    above.docTop = 0;
    above.docHeight = 1000;
    const sticky = new Element('div', 'sticky');
    sticky.className = 'sticky-nav-target';
    sticky.docTop = 1000;
    sticky.docHeight = 40;
    sticky.previousElementSibling = above;
    stickyParent.appendChild(above);
    stickyParent.appendChild(sticky);
    doc.body.appendChild(navWrap);
    doc.body.appendChild(stickyParent);
    const navDom = {
        querySelector: sel => (sel === '.sticky-nav-target' ? sticky : null),
        getDocumentBody: () => body,
        getScrollTop: () => win.pageYOffset,
        getViewportWidth: () => 1200,
        Bounds: {fromElement: bounds}
    };
    loadModule({
        file: 'paste/ui/stickynav.js',
        name: 'paste.ui.stickynav',
        deps: ['paste.dom', 'paste.event', 'paste.has', 'paste.ui.utilities.animation-frame'],
        impls: [navDom, eventModule, {touch: false}, driver],
        sharedDocument: doc,
        sharedWindow: win
    });

    const spyNav = new Element('nav', 'spynav');
    spyNav.setAttribute('data-paste-scrollspy', '');
    spyNav.docTop = 0;
    spyNav.docHeight = 50;
    const sections = {};
    const links = [500, 1000, 1500].map((top, index) => {
        const id = 'section' + index;
        const section = new Element('section', id);
        section.docTop = top;
        section.docHeight = 500;
        sections[id] = section;
        return {hash: '#' + id, parentElement: new Element('li', 'item' + index)};
    });
    const spyDom = {
        querySelector: sel => (sel === '[data-paste-scrollspy]' ? spyNav : null),
        get: (idOrSelector, scope) => (scope ? links : sections[idOrSelector] || null),
        stripIdHash: hash => (hash.charAt(0) === '#' ? hash.slice(1) : hash),
        getScrollTop: () => win.pageYOffset,
        getViewportWidth: () => 1200,
        getScrollHeight: () => 100000,
        getViewportHeight: () => 800,
        getDocumentBody: () => ({clientHeight: 800}),
        Bounds: {fromElement: bounds},
        addCssClass: () => stamp('scrollspy'),
        removeCssClass: () => stamp('scrollspy')
    };
    loadModule({
        file: 'paste/ui/scrollspy.js',
        name: 'paste.ui.scrollspy',
        deps: ['paste.dom', 'paste.event', 'paste.has', 'paste.ui.utilities.animation-frame'],
        impls: [spyDom, eventModule, {touch: false}, driver],
        sharedDocument: doc,
        sharedWindow: win
    });

    const field = new Element('textarea', 'field');
    field.setAttribute('data-paste-autogrow', '');
    field.clientHeight = 40;
    field.scrollHeight = 40;
    let height = '';
    Object.defineProperty(field.style, 'height', {
        get: () => height,
        set: value => { stamp('autogrow'); height = value; }
    });
    doc.body.appendChild(field);
    loadModule({
        file: 'paste/ui/autogrow.js',
        name: 'paste.ui.autogrow',
        deps: ['paste.dom', 'paste.event', 'paste.ui.utilities.animation-frame'],
        impls: [{get: () => [field]}, eventModule, driver],
        sharedDocument: doc,
        sharedWindow: win
    });
    return {field, sticky};
}

test('every frame user writes its answer to one input in the same host frame, on the shared batch', async () => {
    FakeSubscription.reset();
    const driver = realFrames();
    let frame = 0;
    const tick = driver.tick;
    driver.tick = time => { frame += 1; tick(time); };
    driver.frame = () => frame;
    let plain = 0;
    const request = driver.request;
    driver.request = callback => {
        plain += 1;
        return request(callback);
    };
    const writes = [];
    const places = page();
    // The hero sits lower on this page, so the scrub and the hero
    // both have work at the same offsets.
    const lowerHero = offset => {
        places.hero.rect = {top: 900 - offset, left: 0, bottom: 1500 - offset, right: 800,
            width: 800, height: 600};
        places.heroContent.rect = {top: 1000 - offset, left: 0, bottom: 1200 - offset, right: 800,
            width: 800, height: 200};
    };
    lowerHero(0);
    const stack = openUiStack({
        elements: {scope: places.scope, hero: places.hero},
        scrollscrub: true,
        imagesequence: true,
        frameDriver: driver
    });
    loadHeroscroll(stack, driver);
    const users = loadFrameUsers(stack, driver, writes);
    // Writes to the scrub scope, the sequence host and the hero image.
    [['scrollscrub', places.scope], ['imagesequence', places.host], ['heroscroll', places.heroImage]]
        .forEach(([name, el]) => {
            const style = el.style;
            const setProperty = style.setProperty.bind(style);
            style.setProperty = (prop, value, priority) => {
                writes.push({module: name, frame: driver.frame()});
                return setProperty(prop, value, priority);
            };
        });
    let time = 16;
    driver.tick(time);
    stack.images.forEach(image => image.succeed(800, 450));
    await settlePromises();
    await settlePromises();
    // scrollPage moves the hero as if it opened the page; it is put
    // back where this page has it before any frame reads it.
    const scrollTo = offset => {
        scrollPage(stack, places, offset);
        lowerHero(offset);
    };
    // A first scroll spends every module's one-time recalibration.
    scrollTo(800);
    // Every frame the warm-up asked for runs: the input below arms a
    // fresh one.
    for (let i = 0; i < 10 && driver.pending() > 0; i += 1) {
        time += 16;
        driver.tick(time);
        await settlePromises();
        await settlePromises();
    }
    assert.equal(driver.pending(), 0, 'precondition: the page never settled');
    writes.length = 0;

    // One input: the page scrolls past the sticky threshold and into the
    // next spied section while the field's content grows.
    scrollTo(1040);
    users.field.scrollHeight = 80;
    users.field.fireEvent('input');
    assert.equal(driver.pending(), 1, 'the modules armed ' + driver.pending() + ' host frames');
    assert.deepEqual(writes, [], 'a module wrote outside the frame: ' + JSON.stringify(writes));
    const answering = frame + 1;
    time += 16;
    driver.tick(time);
    const late = new Set();
    // Later frames carry only follow-up work: anything a module still
    // owed this input would land there.
    for (let i = 0; i < 3; i += 1) {
        await settlePromises();
        time += 16;
        driver.tick(time);
    }
    const byModule = {};
    writes.forEach(entry => {
        (byModule[entry.module] = byModule[entry.module] || []).push(entry.frame);
        if (entry.frame !== answering) {
            late.add(entry.module);
        }
    });
    ['stickynav', 'scrollspy', 'autogrow', 'scrollscrub', 'imagesequence', 'heroscroll'].forEach(name => {
        assert.ok(byModule[name] && byModule[name].indexOf(answering) >= 0,
            name + ' did not write in the answering frame: ' + JSON.stringify(byModule));
    });
    ['stickynav', 'scrollspy', 'autogrow'].forEach(name => {
        assert.equal(late.has(name), false,
            name + ' deferred a write past the answering frame: ' + JSON.stringify(byModule));
    });
    assert.equal(plain, 0, 'a module armed a plain frame request instead of a phased pair');
});
