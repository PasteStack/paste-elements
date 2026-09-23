const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
    function element(tagName) {
        const attributes = new Map();
        const el = {
            tagName: tagName.toUpperCase(),
            children: [],
            parsed: null,
            getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
            hasAttribute: key => attributes.has(key),
            setAttribute(key, value) { attributes.set(key, String(value)); },
            removeAttribute(key) { attributes.delete(key); },
            querySelectorAll(selector) {
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
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/io-reply-fragment-envelope/io-reply-fragment-envelope.js'), 'utf8'), {
        document, Array, Object, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.io-reply-fragment-envelope');
            assert.equal(deps.length, 0);
            factory(exports);
        }}
    });
    return {ioReplyFragmentEnvelope: exports, element, document};
}

function envelope(overrides = {}) {
    return Object.assign({
        meta: {code: 200, message: 'OK', time: 1790131202.32},
        data: {fragments: {}, variables: {}}
    }, overrides);
}

test('a success envelope replaces every matching target and counts them', () => {
    const f = fixture();
    const one = f.element('div');
    const two = f.element('section');
    one.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    two.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    const other = f.element('div');
    other.setAttribute('data-paste-io-reply-fragment-target', 'signup');
    f.document.children = [one, two, other];
    const count = f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {feedback: {markup: '<p>Thanks</p>'}}, variables: {}}
    }), 200, f.document);
    assert.equal(count, 2);
    assert.equal(one.innerHTML, '<p>Thanks</p>');
    assert.equal(two.innerHTML, '<p>Thanks</p>');
    assert.equal(other.innerHTML, '');
});

test('the document is the default root', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    const count = f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}
    }), 200);
    assert.equal(count, 1);
    assert.equal(target.innerHTML, '<p>Hi</p>');
});

test('a non-200 status applies nothing', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    assert.equal(f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}
    }), 400, f.document), 0);
    assert.equal(target.innerHTML, '');
});

test('a meta code other than 200 applies nothing', () => {
    const f = fixture();
    const target = f.element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    f.document.children = [target];
    const env = envelope({data: {fragments: {feedback: {markup: '<p>Hi</p>'}}}});
    env.meta.code = 400;
    assert.equal(f.ioReplyFragmentEnvelope.apply(env, 200, f.document), 0);
    assert.equal(target.innerHTML, '');
});

test('an envelope fragment without a matching target is skipped', () => {
    const f = fixture();
    f.document.children = [];
    assert.equal(f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {absent: {markup: '<p>Hi</p>'}}}
    }), 200, f.document), 0);
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
    const count = f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {
            outer: {markup: '<div data-paste-io-reply-fragment-target="inner"></div>'},
            inner: {markup: '<p>X</p>'}
        }, variables: {}}
    }), 200, f.document);
    assert.equal(count, 2);
    assert.equal(outer.innerHTML, '<div data-paste-io-reply-fragment-target="inner"></div>');
    assert.equal(newInner.innerHTML, '<p>X</p>');
    assert.equal(oldInner.innerHTML, '');
});

test('non-string variable values are not written', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-n=num, data-x=nul, data-s=str');
    f.document.children = [el];
    f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {}, variables: {num: 3, nul: null, str: 'ok'}}
    }), 200, f.document);
    assert.equal(el.hasAttribute('data-n'), false);
    assert.equal(el.hasAttribute('data-x'), false);
    assert.equal(el.getAttribute('data-s'), 'ok');
});

test('bound attributes receive present variables only', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-state=status, data-count=count, data-missing=absent');
    f.document.children = [el];
    const count = f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {}, variables: {status: 'done', count: '3'}}
    }), 200, f.document);
    assert.equal(count, 0);
    assert.equal(el.getAttribute('data-state'), 'done');
    assert.equal(el.getAttribute('data-count'), '3');
    assert.equal(el.hasAttribute('data-missing'), false);
});

test('malformed envelopes apply nothing and do not throw', () => {
    const f = fixture();
    for (const bad of [null, undefined, 'x', 42, {}, {meta: {}}, {meta: {code: 200}}, {meta: {code: 200}, data: null}]) {
        assert.equal(f.ioReplyFragmentEnvelope.apply(bad, 200, f.document), 0);
    }
    assert.equal(f.ioReplyFragmentEnvelope.apply(envelope(), '200', f.document), 0);
});
