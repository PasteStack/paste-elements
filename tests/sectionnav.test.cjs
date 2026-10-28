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

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource, loadModule} = require('./fakes.cjs');

function load(file, sandbox) {
    vm.runInNewContext(readModuleSource(file), sandbox);
}

function scrollspyFixture(options) {
    const opts = options || {};
    const nav = {
        attrs: opts.attrs || {},
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
        },
        hasAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attrs, name);
        }
    };
    const sectionLink = hash => ({hash, parentElement: {classes: new Set()}});
    const controlLink = hash => ({hash, classes: ['paste-ui-section-nav-toggle'], parentElement: {classes: new Set()}});
    const links = [
        sectionLink('#one'),
        sectionLink('#two'),
        controlLink('#site-sections'),
        controlLink('#site-sections-toggle')
    ];
    const targets = {'#one': {top: 100}, '#two': {top: 500}};
    const measured = [];
    const handlers = {};
    const dom = {
        requestedSelector: null,
        querySelector(sel) {
            if (sel === '[data-paste-scrollspy]' || sel === '.paste-ui-section-nav') { return nav; }
            return targets[sel] || null;
        },
        stripIdHash(elementId) {
            return elementId.charAt(0) === '#' ? elementId.slice(1) : elementId;
        },
        get(sel, parent) {
            // One argument is an id lookup (getElementById semantics);
            // two is the scoped anchor query the module runs on the nav.
            if (arguments.length === 1) {
                return targets['#' + sel] || null;
            }
            this.requestedSelector = sel;
            assert.equal(parent, nav);
            return sel.includes(':not(.paste-ui-section-nav-toggle)') ? links.filter(l => !l.classes) : links;
        },
        getScrollTop() { return opts.scrollTop; },
        getViewportWidth() { return 1280; },
        getScrollHeight() { return 4000; },
        getDocumentBody() { return {clientHeight: 800}; },
        addCssClass(el, name) { el.classes.add(name); },
        removeCssClass(el, name) { el.classes.delete(name); },
        Bounds: {
            fromElement(el) {
                measured.push(el);
                assert.ok(!el.classes || !el.classes.includes('paste-ui-section-nav-toggle'),
                    'scrollspy measured a disclosure control');
                return el === nav ? {top: 0, height: 65} : {top: el.top, height: 100};
            }
        }
    };
    const Event = function () {};
    Event.Subscription = function (type, target, handler) {
        handlers[type] = handler;
        this.attach = () => {};
        this.detach = () => {};
    };
    const event = {Event, DocumentEvent: {loaded(fn) { fn(); }},
        bind(type, target, handler, context, executeCount) {
            handlers[type] = handler;
        }};
    // The scroll handler coalesces through animation-frame — queue the
    // callback and run it inside scrollTo so the test decides the pass.
    const frames = [];
    const animation_frame = {
        request(cb) { frames.push(cb); return frames.length; },
        // The phased pair is one frame: the read half, then the write half.
        requestPhased(read, write) {
            frames.push(time => {
                read(time);
                write(time);
            });
            return frames.length;
        },
        cancel() {}
    };
    load('paste/ui/scrollspy.js', {
        window: {},
        document: {readyState: 'complete'},
        paste: {define(name, dependencies, factory) {
            assert.equal(name, 'paste.ui.scrollspy');
            factory({}, dom, event, {touch: !!opts.touch}, animation_frame);
        }}
    });
    return {
        nav,
        links,
        dom,
        handlers,
        measured,
        active(index) { return links[index].parentElement.classes.has('active'); },
        scrollTo(value) {
            opts.scrollTop = value;
            handlers.scroll();
            frames.splice(0).forEach(fn => fn(16));
        }
    };
}

test('scrollspy excludes disclosure controls from measurement and grouping', () => {
    const f = scrollspyFixture({scrollTop: 0});
    assert.ok(f.dom.requestedSelector.includes(':not(.paste-ui-section-nav-toggle)'));
    assert.deepEqual(f.measured.filter(el => el.classes), []);
    f.scrollTo(50);
    assert.ok(f.active(0));
    assert.ok(!f.active(1));
    f.scrollTo(450);
    assert.ok(!f.active(0));
    assert.ok(f.active(1));
    assert.ok(!f.links[2].parentElement.classes.has('active'));
    assert.ok(!f.links[3].parentElement.classes.has('active'));
});

test('scrollspy stays inactive on touch without the opt-in attribute', () => {
    const f = scrollspyFixture({touch: true, scrollTop: 450});
    // Touch ineligibility is permanent for the page: no scroll listener
    // exists to drive a selection, and nothing was lit at define.
    assert.equal(f.handlers.scroll, undefined, 'a touch page bound a scroll listener');
    assert.ok(!f.active(0));
    assert.ok(!f.active(1));
});

test('scrollspy opts in on touch when data-spy-touch is present', () => {
    const f = scrollspyFixture({touch: true, attrs: {'data-spy-touch': 'false'}, scrollTop: 0});
    f.scrollTo(450);
    assert.ok(f.active(1));
});

// The stylesheet's target clearance: a zero-specificity scroll-margin on
// :where(:target) — never on every hero, since scroll-margin moves snap areas —
// replaceable through one custom property, whose auto default is the
// nav's own box — the height plus the bottom border. The browser checks
// apply it on real engines; this pins the source shape.
test('the section nav mixin clears its own box for fragment targets', () => {
    const fs = require('fs');
    const path = require('path');
    const scss = fs.readFileSync(path.join(__dirname, '../modules/sectionnav/_mixin.scss'), 'utf8');
    const rules = scss.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
    assert.match(scss, /\$target-clearance: auto\s*\)/, 'the clearance parameter must default to auto');
    assert.match(scss, /@if \$target-clearance \{/, 'a null clearance must omit the rule');
    assert.match(scss, /:where\(:target\) \{\s*scroll-margin-top: var\(--paste-ui-section-nav-clearance, #\{\$clearance\}\);\s*\}/,
        'the rule must be a zero-specificity scroll-margin driven by the custom property');
    assert.match(scss, /\$border-width: nth\(\$border-bottom, 1\);/, 'auto must read the bottom border width');
    assert.match(scss, /\$clearance: \$height \+ \$border-width;/, 'auto must add the border to the nav height');
    assert.doesNotMatch(rules, /scroll-padding/, 'a scroll-padding default would add to pages\' own scroll-margin');
    // Pages that clear their chrome with scroll-padding are told how to
    // switch the default off, so the two are never summed.
    assert.match(scss, /scroll-padding-top sets the custom property to 0px, or passes null/,
        'the mixin must document the opt-out for scroll-padding pages');
    assert.doesNotMatch(rules, /paste-ui-hero|data-hero-hashclick/,
        'the clearance belongs only to the browser fragment target');
    assert.match(scss, /scroll-margin also grows a\n\/\/ scroll-snap area/, 'the snap interaction must be documented');
});
