const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function matchOne(element, selector) {
    const m = selector.match(/^([a-z]+)?(\[([a-zA-Z-]+)(="([^"]*)")?\])?$/i);
    if (!m) {
        return false;
    }
    const [, tag, , attribute, , value] = m;
    if (tag && element.tagName !== tag.toUpperCase()) {
        return false;
    }
    if (attribute) {
        if (!element.hasAttribute(attribute)) {
            return false;
        }
        if (value !== undefined && element.getAttribute(attribute) !== value) {
            return false;
        }
    }
    return Boolean(tag || attribute);
}

function query(element, selector) {
    const selectors = selector.split(',').map(part => part.trim());
    const found = [];
    (function walk(node) {
        (node.children || []).forEach(child => {
            if (selectors.some(sel => matchOne(child, sel))) {
                found.push(child);
            }
            walk(child);
        });
    })(element);
    return found;
}

function fixture(options = {}) {
    const ioCalls = [];

    function element(tagName) {
        const attributes = new Map();
        const el = {
            tagName: tagName.toUpperCase(),
            parentElement: null,
            children: [],
            focused: false,
            parsed: null,
            listeners: {},
            getAttribute: key => attributes.has(key) ? attributes.get(key) : null,
            hasAttribute: key => attributes.has(key),
            setAttribute(key, value) { attributes.set(key, String(value)); },
            removeAttribute(key) { attributes.delete(key); },
            addEventListener(type, fn) { el.listeners[type] = fn; },
            removeEventListener(type, fn) {
                if (el.listeners[type] === fn) {
                    delete el.listeners[type];
                }
            },
            querySelector(selector) { return query(el, selector)[0] || null; },
            querySelectorAll(selector) { return query(el, selector); },
            appendChild(child) {
                el.children.push(child);
                child.parentElement = el;
                return child;
            },
            focus() { el.focused = true; },
            requestSubmit(submitter) {
                // The own method delegates to the prototype's; a test may
                // replace it to simulate a control named "requestSubmit".
                window.HTMLFormElement.prototype.requestSubmit.call(el, submitter);
            }
        };
        let html = '';
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

    function submitEvent(submitter, overrides = {}) {
        const event = {
            defaultPrevented: false,
            submitter: submitter || null,
            prevented: 0,
            preventDefault() {
                event.prevented += 1;
                event.defaultPrevented = true;
            }
        };
        return Object.assign(event, overrides);
    }

    function fakeXhr(url) {
        const headers = new Map();
        const request = {
            responseText: '',
            responseURL: url,
            getResponseHeader: key => {
                const k = key.toLowerCase();
                return headers.has(k) ? headers.get(k) : null;
            },
            reply(status, contentType, body, responseURL) {
                request.responseText = body;
                if (responseURL !== undefined) {
                    request.responseURL = responseURL;
                }
                if (contentType !== undefined) {
                    headers.set('content-type', contentType);
                }
                const call = ioCalls.find(c => c.request === request);
                if (status >= 200 && status < 300) {
                    call.onSuccess(body, status, request);
                } else {
                    call.onFailure(body, status, request);
                }
            }
        };
        return request;
    }

    const io = {
        get(url, data, onSuccess, onFailure) {
            const request = fakeXhr(url);
            ioCalls.push({kind: 'get', url, data, onSuccess, onFailure, request});
            return request;
        },
        post(url, data, onSuccess, onFailure) {
            const request = fakeXhr(url);
            ioCalls.push({kind: 'post', url, data, onSuccess, onFailure, request});
            return request;
        }
    };

    const formDataInstances = [];
    function FakeFormData(form, submitter) {
        if (options.formDataThrows && submitter !== undefined) {
            throw new TypeError('no submitter argument');
        }
        if (options.formDataIgnoresSubmitter) {
            submitter = undefined;
        }
        const instance = {
            entries: (form.fields || []).slice(),
            submitter,
            has(name) { return instance.entries.some(([entryName]) => entryName === name); },
            forEach(fn) { instance.entries.forEach(([name, value]) => fn(value, name, instance)); }
        };
        if (submitter && submitter.name) {
            const index = typeof submitter.fieldIndex === 'number' ? submitter.fieldIndex : instance.entries.length;
            instance.entries.splice(index, 0, [submitter.name, submitter.value]);
        }
        formDataInstances.push(instance);
        return instance;
    }

    const target = element('div');
    target.setAttribute('data-paste-io-reply-fragment-target', 'feedback');
    const form = element('form');
    form.setAttribute('data-paste-form', '');
    form.setAttribute('action', '/feedback');
    form.setAttribute('method', 'post');
    form.fields = options.fields || [['email', 'a b@example.test']];
    form.parentElement = target;
    target.children = [form];
    const unmarked = options.unmarked ? element('form') : null;
    if (unmarked) {
        unmarked.setAttribute('action', '/feedback');
        unmarked.parentElement = target;
        target.children = [form, unmarked];
    }
    const page = element('html');
    page.children = [target];
    if (options.baseTarget) {
        const base = element('base');
        base.setAttribute('target', options.baseTarget);
        page.children.push(base);
    }
    if (options.detached) {
        form.parentElement = page;
        page.children = [form];
        target.children = [];
    }

    const document = {
        children: [page],
        baseURI: options.baseURI,
        createElement: tagName => element(tagName),
        querySelector: selector => query(document, selector)[0] || null,
        querySelectorAll: selector => query(document, selector)
    };

    const window = {
        WeakMap: options.noWeakMap ? undefined : WeakMap,
        XMLHttpRequest: function XMLHttpRequest() { },
        URL,
        URLSearchParams,
        location: {href: 'https://example.test/page', origin: 'https://example.test'},
        HTMLFormElement: {prototype: {
            requestSubmit(submitter) {
                // The module invokes this with .call($form), so `this` is the form.
                if (options.throwingRequestSubmit) {
                    throw new Error('submitter detached');
                }
                this.submitted = (this.submitted || 0) + 1;
                this.lastSubmitter = submitter;
                if (this.listeners.submit) {
                    this.listeners.submit(submitEvent(submitter));
                }
            },
            submit() {
                // The module invokes this with .call($form), so `this` is the form.
                this.prototypeSubmitted = (this.prototypeSubmitted || 0) + 1;
            }
        }}
    };
    if (options.noFormData) {
        window.FormData = undefined;
    } else {
        window.FormData = FakeFormData;
    }
    if (options.noURLSearchParams) {
        window.URLSearchParams = undefined;
    }
    if (options.noURL) {
        window.URL = undefined;
    }
    if (options.noRequestSubmit) {
        window.HTMLFormElement.prototype.requestSubmit = undefined;
    }
    if (!options.noResponseURL) {
        window.XMLHttpRequest.prototype.responseURL = '';
    }

    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../modules/form/form.js'), 'utf8'), {
        window, document, Array, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.form');
            assert.equal(deps.length, 1);
            assert.equal(deps[0], 'paste.io');
            factory(exports, io);
        }}
    });
    // The module probes FormData's submitter argument during evaluation;
    // instances a submit creates start at index 0 for the tests.
    formDataInstances.length = 0;
    // Forms present when the module runs are enhanced during evaluation.
    return {exports, io, ioCalls, window, document, target, form, unmarked, element, submitEvent, FakeFormData, formDataInstances};
}

function submit(f, submitter) {
    const event = f.submitEvent(submitter);
    if (f.form.listeners.submit) {
        f.form.listeners.submit(event);
    }
    return event;
}

test('urlencoded post sends a query-string body including the submitter', () => {
    const f = fixture();
    const submitter = {name: 'go', value: 'Send now'};
    const event = submit(f, submitter);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls.length, 1);
    const call = f.ioCalls[0];
    assert.equal(call.kind, 'post');
    assert.equal(call.url, 'https://example.test/feedback');
    assert.equal(typeof call.data, 'string');
    assert.equal(call.data, 'email=a+b%40example.test&go=Send+now');
    assert.equal(f.formDataInstances[0].submitter, submitter);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
});

test('multipart post passes the FormData instance through', () => {
    const f = fixture();
    f.form.setAttribute('enctype', 'multipart/form-data');
    submit(f, {name: 'go', value: 'Send'});
    const call = f.ioCalls[0];
    assert.ok(f.formDataInstances.includes(call.data));
    assert.deepEqual(call.data.entries, [['email', 'a b@example.test'], ['go', 'Send']]);
});

test('the submitter entry keeps its document position', () => {
    const f = fixture({fields: [['op', 'default']]});
    submit(f, {name: 'op', value: 'delete', fieldIndex: 0});
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.ioCalls[0].data, 'op=delete&op=default');
});

test('a browser whose FormData ignores the submitting button is left alone', () => {
    const f = fixture({formDataIgnoresSubmitter: true});
    const event = submit(f, {name: 'go', value: 'Send'});
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a browser whose FormData cannot take a submitter argument is left alone', () => {
    const f = fixture({formDataThrows: true});
    const event = submit(f, {name: 'go', value: 'Send'});
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a submit without a submitter passes null to FormData', () => {
    const f = fixture();
    submit(f);
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.ioCalls[0].data, 'email=a+b%40example.test');
    assert.equal(f.formDataInstances[0].submitter, null);
});

test('get appends the fields to the action as a query string', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    const call = f.ioCalls[0];
    assert.equal(call.kind, 'get');
    assert.equal(call.url, 'https://example.test/feedback?email=a+b%40example.test');
    assert.equal(call.data, null);
});

test('get replaces the action\'s existing query and drops its fragment', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    f.form.setAttribute('action', 'https://example.test/feedback?lang=en#details');
    submit(f);
    assert.equal(f.ioCalls[0].url, 'https://example.test/feedback?email=a+b%40example.test');
});

test('a submitter formaction overrides the form action', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.name = 'go';
    submitter.value = 'Send now';
    submitter.setAttribute('formaction', '/other');
    const event = submit(f, submitter);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.ioCalls[0].url, 'https://example.test/other');
    assert.equal(f.ioCalls[0].data, 'email=a+b%40example.test&go=Send+now');
});

test('a submitter formmethod overrides the form method', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.setAttribute('formmethod', 'get');
    submit(f, submitter);
    const call = f.ioCalls[0];
    assert.equal(call.kind, 'get');
    assert.equal(call.url, 'https://example.test/feedback?email=a+b%40example.test');
});

test('a submitter formenctype overrides the form enctype', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.setAttribute('formenctype', 'multipart/form-data');
    submit(f, submitter);
    const call = f.ioCalls[0];
    assert.equal(call.kind, 'post');
    assert.ok(f.formDataInstances.includes(call.data));
});

test('a cross-origin submitter formaction is left to submit natively', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.setAttribute('formaction', 'https://other.test/feedback');
    const event = submit(f, submitter);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a form target of _blank is left to submit natively', () => {
    const f = fixture();
    f.form.setAttribute('target', '_blank');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a submitter formtarget of _blank is left to submit natively', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.setAttribute('formtarget', '_blank');
    const event = submit(f, submitter);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a base target of _blank with no form or submitter target is left to submit natively', () => {
    const f = fixture({baseTarget: '_blank'});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a form target overrides a base target', () => {
    const f = fixture({baseTarget: '_blank'});
    f.form.setAttribute('target', '_self');
    const event = submit(f);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('a form target of _self is intercepted, whatever its case', () => {
    const f = fixture();
    f.form.setAttribute('target', '_SELF');
    const event = submit(f);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('a text/plain post is left to submit natively', () => {
    const f = fixture();
    f.form.setAttribute('enctype', 'text/plain');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a submitter formenctype of text/plain on a post is left to submit natively', () => {
    const f = fixture();
    const submitter = f.element('button');
    submitter.setAttribute('formenctype', 'text/plain');
    const event = submit(f, submitter);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a browser that does not report SubmitEvent.submitter is left alone', () => {
    const f = fixture();
    const event = f.submitEvent(null, {submitter: undefined});
    f.form.listeners.submit(event);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a relative action resolves against the document base URL', () => {
    const f = fixture({baseURI: 'https://example.test/base/dir/'});
    f.form.setAttribute('action', 'sub');
    submit(f);
    assert.equal(f.ioCalls[0].url, 'https://example.test/base/dir/sub');
});

test('an empty action submits to the document URL', () => {
    const f = fixture();
    f.form.setAttribute('action', '');
    const event = submit(f);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls[0].url, 'https://example.test/page');
});

test('a cross-origin action is left to submit natively', () => {
    const f = fixture();
    f.form.setAttribute('action', 'https://other.test/feedback');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('an unresolvable action is left to submit natively', () => {
    const f = fixture();
    f.form.setAttribute('action', 'http://[bad');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a method other than get or post is left to submit natively', () => {
    const f = fixture();
    f.form.setAttribute('method', 'dialog');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('missing URL leaves the submit alone', () => {
    const f = fixture({noURL: true});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a form outside any IO reply fragment target is left to submit natively', () => {
    const f = fixture({detached: true});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('an already default-prevented submit is left alone', () => {
    const f = fixture();
    const event = f.submitEvent(null, {defaultPrevented: true});
    f.form.listeners.submit(event);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('missing FormData leaves the submit alone', () => {
    const f = fixture({noFormData: true});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('missing URLSearchParams leaves the submit alone', () => {
    const f = fixture({noURLSearchParams: true});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a second submit while in flight is swallowed', () => {
    const f = fixture();
    submit(f);
    const second = submit(f);
    assert.equal(second.prevented, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('an HTML error page replaces the target, re-enhances forms and focuses the alert', () => {
    const f = fixture();
    const innerForm = f.element('form');
    innerForm.setAttribute('data-paste-form', '');
    const alert = f.element('p');
    alert.setAttribute('role', 'alert');
    f.target.parsed = [innerForm, alert];
    submit(f);
    f.ioCalls[0].request.reply(400, 'text/html; charset=utf-8', '<form data-paste-form></form><p role="alert">Nope</p>');
    assert.equal(f.target.innerHTML, '<form data-paste-form></form><p role="alert">Nope</p>');
    assert.equal(typeof innerForm.listeners.submit, 'function');
    assert.equal(alert.getAttribute('tabindex'), '-1');
    assert.equal(alert.focused, true);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    const again = f.submitEvent(null);
    innerForm.listeners.submit(again);
    assert.equal(again.prevented, 1);
});

test('an image submitter is left to the browser', () => {
    const f = fixture();
    const submitter = f.element('input');
    submitter.type = 'image';
    submitter.name = 'go';
    const event = submit(f, submitter);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a browser without XMLHttpRequest.prototype.responseURL leaves the submit alone', () => {
    const f = fixture({noResponseURL: true});
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('an HTML response from a cross-origin final URL resubmits natively and is not placed', () => {
    const f = fixture();
    f.target.innerHTML = '<p>original</p>';
    const submitter = {name: 'go', value: 'Send'};
    submit(f, submitter);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>other</p>', 'https://other.test/landing');
    assert.equal(f.target.innerHTML, '<p>original</p>');
    assert.equal(f.form.submitted, 1);
    assert.equal(f.form.lastSubmitter, submitter);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('an HTML response with an empty responseURL resubmits natively', () => {
    const f = fixture();
    f.target.innerHTML = '<p>original</p>';
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>other</p>', '');
    assert.equal(f.target.innerHTML, '<p>original</p>');
    assert.equal(f.form.submitted, 1);
});

test('an HTML response redirected within the page origin is placed normally', () => {
    const f = fixture();
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>redirected</p>', 'https://example.test/elsewhere');
    assert.equal(f.target.innerHTML, '<p>redirected</p>');
    assert.equal(f.form.submitted, undefined);
});

test('a non-HTML response resubmits natively and the re-fired submit passes through', () => {
    const f = fixture();
    submit(f);
    f.ioCalls[0].request.reply(200, 'application/json', '{}');
    assert.equal(f.form.submitted, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    // The re-fired submit hit the listener with the bypass flag set: not
    // prevented, no second request, and the flag is cleared afterwards.
    assert.equal(f.ioCalls.length, 1);
    const next = submit(f);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('request error events fall back exactly once', () => {
    const f = fixture();
    submit(f);
    const request = f.ioCalls[0].request;
    request.onerror();
    request.onerror();
    request.onabort();
    assert.equal(f.form.submitted, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('a load paste.io never reported resubmits natively exactly once', () => {
    const f = fixture();
    submit(f);
    const request = f.ioCalls[0].request;
    const onSubmit = f.form.listeners.submit;
    let refired;
    f.form.listeners.submit = event => {
        refired = event;
        onSubmit(event);
    };
    request.onload();
    request.onload();
    assert.equal(f.form.submitted, 1);
    assert.equal(refired.prevented, 0);
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    const next = submit(f);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('load after a placed HTML reply does nothing', () => {
    const f = fixture();
    submit(f);
    const request = f.ioCalls[0].request;
    request.reply(200, 'text/html; charset=utf-8', '<p>ok</p>');
    request.onload();
    assert.equal(f.target.innerHTML, '<p>ok</p>');
    assert.ok(!f.form.submitted);
    assert.ok(!f.form.prototypeSubmitted);
});

test('prototype submit is used when requestSubmit is unavailable', () => {
    const f = fixture({noRequestSubmit: true});
    submit(f);
    f.ioCalls[0].request.reply(0, undefined, '');
    assert.equal(f.form.prototypeSubmitted, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a control named requestSubmit shadowing the method still resubmits natively with the submitter', () => {
    const f = fixture();
    const submitter = {name: 'go', value: 'Send'};
    // A form control named "requestSubmit" becomes an own property that hides
    // the method, exactly as a control named "submit" does.
    f.form.requestSubmit = {name: 'requestSubmit'};
    submit(f, submitter);
    f.ioCalls[0].request.reply(200, 'application/json', '{}');
    assert.equal(f.form.submitted, 1);
    assert.equal(f.form.lastSubmitter, submitter);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a throwing requestSubmit falls back to prototype submit exactly once', () => {
    const f = fixture({throwingRequestSubmit: true});
    submit(f);
    f.ioCalls[0].request.reply(0, undefined, '');
    assert.equal(f.form.prototypeSubmitted, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    // The bypass flag was reset: a later submit is intercepted normally.
    const again = submit(f);
    assert.equal(again.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('forms present when the module runs are enhanced at module evaluation', () => {
    const f = fixture();
    assert.equal(typeof f.form.listeners.submit, 'function');
    const event = submit(f);
    assert.equal(event.prevented, 1);
});

test('the module publishes no API', () => {
    const f = fixture();
    assert.equal(Object.keys(f.exports).length, 0);
});

test('markup without data-paste-form is not enhanced', () => {
    const f = fixture({unmarked: true});
    assert.equal(f.unmarked.listeners.submit, undefined);
    // Nor when it arrives inside swapped IO reply fragment markup.
    const injected = f.element('form');
    f.target.parsed = [injected];
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<form></form>');
    assert.equal(injected.listeners.submit, undefined);
});

test('browsers without WeakMap are left alone', () => {
    const f = fixture({noWeakMap: true});
    assert.equal(f.form.listeners.submit, undefined);
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.ioCalls.length, 0);
});

test('a form is enhanced only once even when a swapped IO reply fragment contains it again', () => {
    const f = fixture();
    let adds = 0;
    const add = f.form.addEventListener;
    f.form.addEventListener = (type, fn, capture) => {
        adds += 1;
        add(type, fn, capture);
    };
    f.target.parsed = [f.form];
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<form data-paste-form></form>');
    // The re-scan found the form already enhanced: no second listener bound.
    assert.equal(adds, 0);
    const again = submit(f);
    assert.equal(again.prevented, 1);
});
