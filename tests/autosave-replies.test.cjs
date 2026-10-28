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
const {readModuleSource} = require('./fakes.cjs');

function fixture() {
    function element(tagName) {
        const attributes = new Map();
        const el = {
            tagName: tagName.toUpperCase(),
            nodeType: tagName === '#document' ? 9 : 1,
            children: [],
            parsed: null,
            getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
            hasAttribute: key => attributes.has(key),
            setAttribute(key, value) { attributes.set(key, String(value)); },
            removeAttribute(key) { attributes.delete(key); },
            contains(node) {
                return node === el || (el.children || []).some(child => child.contains(node));
            },
            querySelectorAll(selector) {
                if (selector === 'form[data-ui-autosave]') return [];
                const attribute = selector.match(/^\[([a-z-]+)\]$/i)[1];
                const found = [];
                (function walk(node) {
                    (node.children || []).forEach(child => {
                        if (child.hasAttribute(attribute)) {
                            found.push(child);
                        }
                        walk(child);
                    });
                })(el);
                return found;
            }
        };
        let html = '';
        // Assigning innerHTML swaps in pre-parsed children the test staged
        // on el.parsed, replacing whatever children the element had.
        Object.defineProperty(el, 'innerHTML', {
            configurable: true,
            get: () => html,
            set: value => {
                html = value;
                if (el.parsed) {
                    el.children = el.parsed;
                    el.parsed.forEach(child => { child.parentElement = el; });
                    el.parsed = null;
                }
            }
        });
        return el;
    }
    const document = element('#document');
    const exports = {};
    const handlers = new Map();
    const scheduled = [];
    let complete;
    function HTMLFormElement() {}
    Object.defineProperty(HTMLFormElement.prototype, 'elements', {
        get() { return this.elements; }
    });
    const fragment = {};
    vm.runInNewContext(readModuleSource('paste/ui/utilities/io-html-fragment.js'), {
        document, window: require('./fakes.cjs').fragmentDomWindow({}), paste: {define(name, deps, make) { make(fragment, {}); }}
    });
    vm.runInNewContext(readModuleSource('paste/ui/form/form_autosave.js'), {
        document, Array, Object, console,
        window: {WeakMap, HTMLFormElement, FormData: function () {}, setTimeout: (fn, delay) => { scheduled.push({fn,delay}); return scheduled.length; }, clearTimeout() {}},
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.form.form_autosave');
            assert.deepEqual(Array.from(deps), ['paste.event', 'paste.io', 'paste.ui.utilities.form-dom', 'paste.ui.utilities.io-html-fragment']);
            factory(exports, {bind(type, target, fn, context) {
                if (type === 'change') handlers.set(target, () => fn.call(context, {type}));
            }}, {open(method, url, success) {
                assert.equal(method, 'POST');
                complete = success;
                return {send() { assert.equal(this.timeout, 30000, 'autosave must set its deadline before transmission'); }};
            }}, require('./fakes.cjs').loadFormDom({HTMLFormElement}), fragment);
        }}
    });
    // Observe private reply handling through an actual autosave request.
    // No public apply/root/count API is added just to preserve the old tests.
    function respond(reply, status, afterSend) {
        const form = element('form');
        const field = element('input');
        field.name = 'value'; field.type = 'text'; field.value = 'before';
        form.elements = [field];
        form.classList = {add() {}, remove() {}, toggle() {}};
        form.setAttribute('data-ui-autosave', 'value');
        form.setAttribute('data-autosave-action', '/save');
        document.children.push(form);
        exports.init(form);
        field.value = 'after';
        complete = null;
        handlers.get(field)();
        assert.equal(typeof complete, 'function', 'an edit must send before a reply can apply');
        if (afterSend) afterSend(field,form);
        complete(reply, status);
    }
    return {respond, element, document, scheduled};
}

function envelope(overrides = {}) {
    return Object.assign({
        meta: {code: 200, message: 'OK', time: 1790131202.32},
        data: {fragments: {}, variables: {}}
    }, overrides);
}

test('original autosave modules and scalar bindings are applied by autosave', () => {
    const f = fixture(), target = f.element('div'), binding = f.element('span');
    target.setAttribute('data-update-contents', 'summary');
    binding.setAttribute('data-update-attribute', 'data-count=count,data-enabled=enabled,data-label=label');
    f.document.children = [target, binding];
    const reply = {meta: {code: 200}, data: {modules: {summary: {markup: '<b>Saved</b>'}},
        variables: {count: 0, enabled: false, label: 'ready'}}};
    f.respond(reply, 200);
    assert.equal(target.innerHTML, '<b>Saved</b>');
    assert.equal(binding.getAttribute('data-count'), '0');
    assert.equal(binding.getAttribute('data-enabled'), 'false');
    assert.equal(binding.getAttribute('data-label'), 'ready');
});



test('Surface writes follow original writes when a consumer deliberately authors both hooks', () => {
    const f = fixture(), target = f.element('div');
    target.setAttribute('data-update-contents', 'old');
    target.setAttribute('data-paste-io-reply-fragment-target', 'new');
    target.setAttribute('data-update-attribute', 'data-version=old');
    target.setAttribute('data-paste-io-reply-fragment-bind', 'data-version=new');
    f.document.children = [target];
    f.respond({meta: {code: 200}, data: {
        modules: {old: {markup: 'old'}}, fragments: {new: {markup: 'new'}}, variables: {old: '1', new: '2'}
    }}, 200);
    assert.equal(target.innerHTML, 'new');
    assert.equal(target.getAttribute('data-version'), '2');
});

test('a success envelope replaces every matching target', () => {
    const f = fixture();
    const one = f.element('div');
    const two = f.element('section');
    one.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    two.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    const other = f.element('div');
    other.setAttribute('data-paste-io-reply-fragment-target', 'signup');
    f.document.children = [one, two, other];
    f.respond(envelope({
        data: {fragments: {feedback: {markup: '<p>Thanks</p>'}}, variables: {}}
    }), 200);
    assert.equal(one.innerHTML, '<p>Thanks</p>');
    assert.equal(two.innerHTML, '<p>Thanks</p>');
    assert.equal(other.innerHTML, '');
});

test('autosave replies address the authored document', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    f.respond(envelope({
        data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}
    }), 200);
    assert.equal(target.innerHTML, '<p>Hi</p>');
});

test('a non-200 status applies nothing', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    f.respond(envelope({
        data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}
    }), 400);
    assert.equal(target.innerHTML, '');
});

test('a meta code other than 200 applies nothing', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    const env = envelope({data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}});
    env.meta.code = 400;
    f.respond(env, 200);
    assert.equal(target.innerHTML, '');
});

test('an envelope fragment without a matching target is skipped', () => {
    const f = fixture();
    f.document.children = [];
    f.respond(envelope({
        data: {fragments: {absent: {markup: '<p>Hi</p>'}}}
    }), 200);
});

test('targets are found as each name is applied', () => {
    const f = fixture();
    const outer = f.element('div');
    outer.setAttribute('data-paste-io-reply-fragment-target', 'outer');
    const oldInner = f.element('div');
    oldInner.setAttribute('data-paste-io-reply-fragment-target', 'inner');
    oldInner.parentElement = outer;
    outer.children = [oldInner];
    const newInner = f.element('div');
    newInner.setAttribute('data-paste-io-reply-fragment-target', 'inner');
    // The markup the outer replacement parses to carries a fresh inner target.
    outer.parsed = [newInner];
    f.document.children = [outer];
    f.respond(envelope({
        data: {fragments: {
            outer: {markup: '<div data-paste-io-reply-fragment-target="inner"></div>'},
            inner: {markup: '<p>X</p>'}
        }, variables: {}}
    }), 200);
    assert.equal(outer.innerHTML, '<div data-paste-io-reply-fragment-target="inner"></div>');
    assert.equal(newInner.innerHTML, '<p>X</p>');
    assert.equal(oldInner.innerHTML, '');
});

test('non-string variable values are not written', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-n=num, data-x=nul, data-s=str');
    f.document.children = [el];
    f.respond(envelope({
        data: {fragments: {}, variables: {num: 3, nul: null, str: 'ok'}}
    }), 200);
    assert.equal(el.hasAttribute('data-n'), false);
    assert.equal(el.hasAttribute('data-x'), false);
    assert.equal(el.getAttribute('data-s'), 'ok');
});

test('bound attributes receive present variables only', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-state=status, data-count=count, data-missing=absent');
    f.document.children = [el];
    f.respond(envelope({
        data: {fragments: {}, variables: {status: 'done', count: '3'}}
    }), 200);
    assert.equal(el.getAttribute('data-state'), 'done');
    assert.equal(el.getAttribute('data-count'), '3');
    assert.equal(el.hasAttribute('data-missing'), false);
});

test('malformed envelopes apply nothing and do not throw', () => {
    const f = fixture();
    for (const bad of [null, undefined, 'x', 42, {}, {meta: {}}, {meta: {code: 200}}, {meta: {code: 200}, data: null}]) {
        f.respond(bad, 200);
    }
    f.respond(envelope(), '200');
});

test('a later bind pair for the same attribute wins', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-state=first, data-state=second');
    f.document.children = [el];
    f.respond(envelope({
        data: {fragments: {}, variables: {first: 'one', second: 'two'}}
    }), 200);
    assert.equal(el.getAttribute('data-state'), 'two',
        'bind pairs were not applied in declared order');
});

test('integer-like fragment names apply first, then the rest in declared order', () => {
    // The documented order is the own-key order of data.fragments, not
    // the reply's text order: an integer-like outer name applies after
    // nothing, a non-integer outer name after every integer-like name.
    const f = fixture();
    const order = [];
    const target = name => {
        const el = f.element('div');
        el.setAttribute('data-paste-io-reply-fragment-target', name);
        Object.defineProperty(el, 'innerHTML', {
            get: () => '',
            set: () => order.push(name)
        });
        return el;
    };
    f.document.children = ['b', '10', 'a', '2'].map(target);
    f.respond(envelope({
        data: {fragments: {
            b: {markup: 'x'}, 10: {markup: 'x'}, a: {markup: 'x'}, 2: {markup: 'x'}
        }, variables: {}}
    }), 200);
    assert.deepEqual(order, ['2', '10', 'b', 'a']);
});

test('the documented application order is in the module JSDoc', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname,
        '../modules/form/form_autosave/form_autosave.js'), 'utf8');
    assert.ok(/integer-like/.test(source), 'the integer-like ordering is undocumented');
    assert.equal(/Declared order is semantic/.test(source), false,
        'the comment still claims declared order');
});

test('a target nested in a same-named target is skipped once the outer write detaches it', () => {
    const f = fixture();
    const outer = f.element('div');
    const inner = f.element('div');
    outer.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    inner.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    outer.children = [inner];
    f.document.children = [outer];
    // The outer write replaces its children: the inner target leaves the page.
    outer.parsed = [];
    f.respond(envelope({
        data: {fragments: {feedback: {markup: '<p>Thanks</p>'}}, variables: {}}
    }), 200);
    assert.equal(outer.innerHTML, '<p>Thanks</p>');
    assert.equal(inner.innerHTML, '', 'a detached target was written');
});



test('a bind declaration with a long interior whitespace run trims in linear time', () => {
    const f = fixture();
    const bound = f.element('div');
    bound.setAttribute('data-paste-io-reply-fragment-bind',
        ' data-state = status ,data-x=status' + ' '.repeat(40000) + 'y');
    f.document.children = [bound];
    const started = process.hrtime.bigint();
    f.respond(envelope({
        data: {fragments: {}, variables: {status: 'ok'}}
    }), 200);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(bound.getAttribute('data-state'), 'ok', 'a padded pair was not trimmed');
    assert.ok(elapsed < 250, 'trimming took ' + elapsed.toFixed(0) + ' ms');
});

test('the module documents that fragment markup is trusted same-origin HTML', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname,
        '../modules/form/form_autosave/form_autosave.js'), 'utf8');
    assert.ok(/trusted HTML/.test(source) && /innerHTML/.test(source.slice(0, source.indexOf('paste['))),
        'the innerHTML trust boundary is undocumented');
});

test('variables bind every target after fragment replacement has advanced its own scan', () => {
    const f = fixture();
    const target = f.element('div'), first = f.element('input'), second = f.element('input');
    target.setAttribute('data-paste-io-reply-fragment-target', 'body');
    first.setAttribute('data-paste-io-reply-fragment-bind', 'value=first');
    second.setAttribute('data-paste-io-reply-fragment-bind', 'value=second');
    f.document.children = [target, first, second];
    f.respond(envelope({data: {
        fragments: {body: {markup: '<p>Replaced</p>'}}, variables: {first: 'A', second: 'B'}
    }}), 200);
    assert.equal(first.getAttribute('value'), 'A');
    assert.equal(second.getAttribute('value'), 'B');
});


test('a refused optional reply placement still schedules edits made while saving', () => {
    const f=fixture(),target=f.element('section');
    target.setAttribute('data-paste-io-reply-fragment-target','feedback');
    Object.defineProperty(target,'innerHTML',{set(){throw new TypeError('HTML sink refused');}});
    f.document.children=[target];
    assert.throws(()=>f.respond(envelope({data:{fragments:{feedback:{markup:'reply'}}}}),200,
        field=>{field.value='newer';}),/HTML sink refused/);
    assert.equal(f.scheduled.length,1);
    assert.equal(f.scheduled[0].delay,10000);
});
