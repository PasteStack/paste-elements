const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

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
            contains(node) {
                return node === el || (el.children || []).some(child => child.contains(node));
            },
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
    vm.runInNewContext(readModuleSource('paste/ui/io-reply-fragment-envelope.js'), {
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

test('a later bind pair for the same attribute wins', () => {
    const f = fixture();
    const el = f.element('span');
    el.setAttribute('data-paste-io-reply-fragment-bind', 'data-state=first, data-state=second');
    f.document.children = [el];
    f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {}, variables: {first: 'one', second: 'two'}}
    }), 200, f.document);
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
    f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {
            b: {markup: 'x'}, 10: {markup: 'x'}, a: {markup: 'x'}, 2: {markup: 'x'}
        }, variables: {}}
    }), 200, f.document);
    assert.deepEqual(order, ['2', '10', 'b', 'a']);
});

test('the documented application order is in the module JSDoc', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname,
        '../modules/io-reply-fragment-envelope/io-reply-fragment-envelope.js'), 'utf8');
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
    const count = f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {feedback: {markup: '<p>Thanks</p>'}}, variables: {}}
    }), 200, f.document);
    assert.equal(count, 1, 'a detached target was counted');
    assert.equal(outer.innerHTML, '<p>Thanks</p>');
    assert.equal(inner.innerHTML, '', 'a detached target was written');
});

test('the root itself is a target when it carries the attribute', () => {
    const f = fixture();
    const root = f.element('div');
    root.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    root.parsed = [];
    assert.equal(f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {feedback: {markup: 'x'}}, variables: {}}
    }), 200, root), 1);
    assert.equal(root.innerHTML, 'x');
});

test('a bind declaration with a long interior whitespace run trims in linear time', () => {
    const f = fixture();
    const bound = f.element('div');
    bound.setAttribute('data-paste-io-reply-fragment-bind',
        ' data-state = status ,data-x=status' + ' '.repeat(40000) + 'y');
    f.document.children = [bound];
    const started = process.hrtime.bigint();
    f.ioReplyFragmentEnvelope.apply(envelope({
        data: {fragments: {}, variables: {status: 'ok'}}
    }), 200, f.document);
    const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(bound.getAttribute('data-state'), 'ok', 'a padded pair was not trimmed');
    assert.ok(elapsed < 250, 'trimming took ' + elapsed.toFixed(0) + ' ms');
});

test('the module documents that fragment markup is trusted same-origin HTML', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname,
        '../modules/io-reply-fragment-envelope/io-reply-fragment-envelope.js'), 'utf8');
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
    const count = f.ioReplyFragmentEnvelope.apply(envelope({data: {
        fragments: {body: {markup: '<p>Replaced</p>'}}, variables: {first: 'A', second: 'B'}
    }}), 200, f.document);
    assert.equal(count, 1);
    assert.equal(first.getAttribute('value'), 'A');
    assert.equal(second.getAttribute('value'), 'B');
});
