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

// Request deadlines are authored per element: each XHR transport reads its
// own data-* timeout, following data-paste-form-timeout's contract — decimal
// milliseconds, "0" for no deadline, malformed or overflowing input falls
// back to the 30,000 default. The modules under test are the real sources;
// only io.open is doubled so the armed timeout lands on a readable request.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {loadFormDom, Element, eventModule, readModuleSource} = require('./fakes.cjs');

function HTMLFormElement() {}
Object.defineProperty(HTMLFormElement.prototype, 'elements', {
    get() { return this.elements; }
});
HTMLFormElement.prototype.checkValidity = function () { return true; };

function ioCapture() {
    const calls = [];
    return {
        calls: calls,
        io: {
            open: function (method, url) {
                const request = {send: function () {}, setRequestHeader: function () {}};
                calls.push({method: method, url: url, request: request});
                return request;
            }
        }
    };
}

function FakeFormData() {
    this.map = {};
    this.append = function (name, value) { this.map[name] = value; };
    this.has = function (name) { return name === 'probe' || this.map[name] !== undefined; };
    this.entries = function () {
        const pairs = Object.keys(this.map).map(k => [k, this.map[k]]);
        let index = 0;
        return {next: () => index < pairs.length ? {done: false, value: pairs[index++]} : {done: true}};
    };
}

// Load a real module source into a vm context, capturing the exports object
// the factory populates (these factories assign their API without returning
// it) and asserting its declared dependency order.
function define(file, name, deps, impls, context) {
    const exports = {};
    vm.runInNewContext(readModuleSource(file), Object.assign({
        console: console, Object: Object, Array: Array, JSON: JSON,
        paste: {define(moduleName, dependencies, factory) {
            assert.equal(moduleName, name);
            assert.deepEqual(Array.from(dependencies), deps);
            factory.apply(null, [exports].concat(impls));
        }}
    }, context));
    return exports;
}

const cases = [
    [undefined, 30000], ['', 30000], [' ', 30000], ['later', 30000],
    ['-1', 30000], ['0.5', 30000], ['1.5', 30000], ['1e3', 30000],
    ['0x10', 30000], ['4294967296', 30000],
    ['0', 0], ['1', 1], ['45000', 45000], ['4294967295', 4294967295]
];

test('form_apply honors data-paste-form-timeout on the form', () => {
    cases.forEach(([value, expected]) => {
        const host = ioCapture();
        const form = new Element('form');
        form.setAttribute('class', 'paste-ui-apply');
        form.setAttribute('method', 'post');
        form.setAttribute('action', '/apply');
        form.setAttribute('novalidate', '');
        if (value !== undefined) {
            form.setAttribute('data-paste-form-timeout', value);
        }
        form.elements = [];
        form.classList = {
            contains: name => name === 'paste-ui-apply',
            add() {}, remove() {}, toggle() {}
        };
        const apply = define('paste/ui/form/form_apply.js', 'paste.ui.form.form_apply',
            ['paste.event', 'paste.io', 'paste.guid', 'paste.ui.form.form_validity', 'paste.ui.utilities.form-dom'],
            [eventModule, host.io, {Guid: {create: () => 'g'}}, {init() {}}, loadFormDom({})], {
                document: {
                    nodeType: 9,
                    characterSet: 'UTF-8',
                    createElement: tag => new Element(tag),
                    querySelector: () => null,
                    querySelectorAll: () => []
                },
                window: {WeakMap: WeakMap, FormData: FakeFormData, URLSearchParams: URLSearchParams, HTMLFormElement: HTMLFormElement, location: {href: 'http://localhost/'}}
            });
        apply['init'](form);
        form.dispatchEvent({
            type: 'submit',
            submitter: {type: 'submit', hasAttribute: () => false, getAttribute: () => null},
            preventDefault() {}, defaultPrevented: false
        });
        assert.equal(host.calls.length, 1, 'submit must open one request');
        assert.equal(host.calls[0].request.timeout, expected, 'data-paste-form-timeout=' + JSON.stringify(value));
    });
});

test('form_autosave honors data-autosave-timeout on the form', () => {
    cases.forEach(([value, expected]) => {
        const host = ioCapture();
        const form = new Element('form');
        const field = new Element('input');
        field.name = 'title';
        field.type = 'text';
        field.value = 'before';
        form.setAttribute('data-ui-autosave', 'title');
        form.setAttribute('data-autosave-action', '/draft');
        if (value !== undefined) {
            form.setAttribute('data-autosave-timeout', value);
        }
        form.elements = [field];
        form.classList = {add() {}, remove() {}, toggle() {}, contains: () => false};
        form.appendChild(field);
        const autosave = define('paste/ui/form/form_autosave.js', 'paste.ui.form.form_autosave',
            ['paste.event', 'paste.io', 'paste.ui.utilities.form-dom', 'paste.ui.utilities.io-html-fragment'],
            [eventModule, host.io, loadFormDom({HTMLFormElement: HTMLFormElement}), {}], {
                document: {nodeType: 9, querySelectorAll: () => [], contains: () => true},
                window: {WeakMap: WeakMap, FormData: FakeFormData, HTMLFormElement: HTMLFormElement, setTimeout: () => 1, clearTimeout() {}}
            });
        autosave['init'](form);
        field.value = 'after';
        field.dispatchEvent({type: 'change'});
        assert.equal(host.calls.length, 1, 'an edit must open one request');
        assert.equal(host.calls[0].request.timeout, expected, 'data-autosave-timeout=' + JSON.stringify(value));
    });
});

test('imageupload honors data-image-upload-timeout on the field', () => {
    cases.forEach(([value, expected]) => {
        const host = ioCapture();
        const form = new Element('form');
        const field = new Element('input');
        field.id = 'photo';
        field.type = 'file';
        field.name = 'photo';
        field.setAttribute('data-image-upload-action', '/upload');
        if (value !== undefined) {
            field.setAttribute('data-image-upload-timeout', value);
        }
        const preview = new Element('img');
        preview.setAttribute('data-image-upload-for', 'photo');
        preview.setAttribute('data-image-upload-preview', '');
        const uri = new Element('input');
        uri.setAttribute('data-image-upload-for', 'photo');
        uri.setAttribute('data-image-upload-uri', '');
        const message = new Element('span');
        message.setAttribute('data-image-upload-for', 'photo');
        message.setAttribute('data-image-upload-message', '');
        [preview, uri, message, field].forEach(node => form.appendChild(node));
        const imageupload = define('paste/ui/imageupload.js', 'paste.ui.imageupload',
            ['paste.event', 'paste.io', 'paste.ui.utilities.form-dom'],
            [eventModule, host.io, loadFormDom({HTMLFormElement: HTMLFormElement})], {
                document: {nodeType: 9, forms: [], createEvent: () => ({initEvent() {}}), querySelectorAll: () => []},
                window: {WeakMap: WeakMap, FormData: FakeFormData, HTMLFormElement: HTMLFormElement}
            });
        imageupload['bind'](field, form);
        field.files = [{name: 'photo.png'}];
        field.dispatchEvent({type: 'change'});
        assert.equal(host.calls.length, 1, 'a chosen file must open one request');
        assert.equal(host.calls[0].request.timeout, expected, 'data-image-upload-timeout=' + JSON.stringify(value));
    });
});

test('lazy_loader honors data-lazy-load-timeout on the element', () => {
    const ElementCtor = function () {};
    ElementCtor.prototype = {
        getAttribute: Element.prototype.getAttribute,
        removeAttribute: Element.prototype.removeAttribute,
        querySelectorAll: Element.prototype.querySelectorAll
    };
    const HTMLElementCtor = function () {};
    HTMLElementCtor.prototype = {offsetWidth: 0, offsetHeight: 0};
    cases.forEach(([value, expected]) => {
        const calls = [];
        const fragment = {
            load: function (element, options) {
                calls.push(options);
                return {dispose: function () {}};
            }
        };
        const holder = new Element('div');
        holder.setAttribute('data-lazy-load', '/fragment');
        if (value !== undefined) {
            holder.setAttribute('data-lazy-load-timeout', value);
        }
        const loader = define('paste/ui/lazy_loader.js', 'paste.ui.lazy_loader',
            ['paste.ui.utilities.io-html-fragment'], [fragment], {
                document: {nodeType: 9, querySelectorAll: () => []},
                window: {WeakMap: WeakMap, Element: ElementCtor, HTMLElement: HTMLElementCtor}
            });
        loader['load_lazy_content'](holder);
        assert.equal(calls.length, 1, 'a declared element must issue one load');
        assert.equal(calls[0].timeout, expected, 'data-lazy-load-timeout=' + JSON.stringify(value));
    });
});

test('fragment_navigation honors data-paste-io-reply-fragment-timeout on the anchor', () => {
    const ElementCtor = function () {};
    ElementCtor.prototype = {
        closest: function (selector) { return this.tagName === selector.toUpperCase() ? this : null; },
        getAttribute: Element.prototype.getAttribute,
        hasAttribute: Element.prototype.hasAttribute,
        setAttribute: Element.prototype.setAttribute,
        scrollIntoView: function () {}
    };
    const HTMLElementCtor = function () {};
    HTMLElementCtor.prototype = {focus: function () {}};
    cases.forEach(([value, expected]) => {
        const calls = [];
        const fragment = {
            load: function (element, options) {
                calls.push(options);
                return {dispose: function () {}};
            }
        };
        const anchor = new Element('a');
        anchor.setAttribute('data-paste-io-reply-fragment', 'main');
        anchor.setAttribute('href', 'http://localhost/page2');
        anchor.href = 'http://localhost/page2';
        if (value !== undefined) {
            anchor.setAttribute('data-paste-io-reply-fragment-timeout', value);
        }
        const target = new Element('div');
        target.setAttribute('data-paste-io-reply-fragment-target', 'main');
        const document = {
            nodeType: 9,
            title: '',
            listeners: {},
            addEventListener: function (name, listener) { this.listeners[name] = listener; },
            removeEventListener: function () {},
            querySelector: function (selector) {
                return selector === 'a[data-paste-io-reply-fragment]' ? anchor : null;
            },
            querySelectorAll: function (selector) {
                return selector === '[data-paste-io-reply-fragment-target]' ? [target] : [];
            },
            getElementById: function () { return null; }
        };
        define('paste/ui/fragment_navigation.js', 'paste.ui.fragment_navigation',
            ['paste.event', 'paste.ui.utilities.io-html-fragment'],
            [eventModule, fragment], {
                document: document,
                window: {
                    Element: ElementCtor,
                    HTMLElement: HTMLElementCtor,
                    URL: URL,
                    location: {href: 'http://localhost/', origin: 'http://localhost'},
                    history: {pushState: function () {}, replaceState: function () {}},
                    WeakMap: WeakMap,
                    addEventListener: function () {}
                }
            });
        const click = document.listeners['click'];
        assert.equal(typeof click, 'function', 'an eligible document installs the click binding');
        click({defaultPrevented: false, button: 0, target: anchor, preventDefault: function () {}});
        assert.equal(calls.length, 1, 'an eligible click issues one fragment load');
        assert.equal(calls[0].timeout, expected, 'data-paste-io-reply-fragment-timeout=' + JSON.stringify(value));
    });
});
