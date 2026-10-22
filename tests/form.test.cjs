const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

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
            dispatchEvent(evt) {
                // Bubbling is walked, not captured — enough for the module's
                // single form-level dispatch.
                let node = el;
                do {
                    const fn = node.listeners && node.listeners[evt.type];
                    if (fn) { fn(evt); }
                    node = evt.bubbles ? node.parentElement : null;
                } while (node);
                return !evt.defaultPrevented;
            },
            appendChild(child) {
                el.children.push(child);
                child.parentElement = el;
                return child;
            },
            removeChild(child) {
                const index = el.children.indexOf(child);
                if (index !== -1) {
                    el.children.splice(index, 1);
                    child.parentElement = null;
                }
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
            // A real XHR reports status 0 from construction — never undefined.
            status: 0,
            getResponseHeader: key => {
                const k = key.toLowerCase();
                return headers.has(k) ? headers.get(k) : null;
            },
            // A real abort() on a pending request dispatches its abort
            // event before it returns.
            abort() {
                request.aborted = (request.aborted || 0) + 1;
                if (options.abortThrows) {
                    throw new Error('abort refused');
                }
                if (request.onabort && !options.abortDispatchesNothing) {
                    request.onabort();
                }
            },
            reply(status, contentType, body, responseURL) {
                request.responseText = body;
                request.status = status;
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
            if (options.nullRequest) {
                return null;
            }
            if (options.ioThrows) {
                throw new Error('open refused');
            }
            const request = fakeXhr(url);
            ioCalls.push({kind: 'get', url, data, onSuccess, onFailure, request});
            if (options.syncReply) {
                // A client that answers before it returns.
                request.reply(...options.syncReply);
            }
            return request;
        },
        post(url, data, onSuccess, onFailure) {
            if (options.nullRequest) {
                return null;
            }
            if (options.ioThrows) {
                throw new Error('open refused');
            }
            const request = fakeXhr(url);
            ioCalls.push({kind: 'post', url, data, onSuccess, onFailure, request});
            if (options.syncReply) {
                request.reply(...options.syncReply);
            }
            return request;
        }
    };

    const formDataInstances = [];
    function FakeFormData(form, submitter) {
        // The real capability probe requires a submitter owned by its form.
        if (!form.fields && submitter && submitter.parentElement !== form) {
            throw new TypeError('submitter is not owned by this form');
        }
        if (options.formDataThrows && submitter !== undefined) {
            throw new TypeError('no submitter argument');
        }
        if (options.formDataThrowsOnSubmit && form.fields) {
            throw new TypeError('form data refused');
        }
        if (options.formDataIgnoresSubmitter) {
            submitter = undefined;
        }
        // The collection API only: has() and the entries() iterator — no
        // forEach, so the module must walk the iterator itself.
        const list = (form.fields || []).slice();
        const instance = {
            list,
            submitter,
            has(name) { return list.some(([entryName]) => entryName === name); },
            entries() { return list[Symbol.iterator](); }
        };
        if (submitter && submitter.name) {
            const index = typeof submitter.fieldIndex === 'number' ? submitter.fieldIndex : list.length;
            list.splice(index, 0, [submitter.name, submitter.value]);
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
    // A second enhanced form: beside the first in its target, or inside
    // a target nested in it.
    let second = null;
    let inner = null;
    if (options.secondForm || options.innerTarget) {
        second = element('form');
        second.setAttribute('data-paste-form', '');
        second.setAttribute('action', '/second');
        second.setAttribute('method', 'post');
        second.fields = [['note', 'b']];
        let holder = target;
        if (options.innerTarget) {
            inner = element('div');
            inner.setAttribute('data-paste-io-reply-fragment-target', 'inner');
            inner.parentElement = target;
            target.children.push(inner);
            holder = inner;
        }
        second.parentElement = holder;
        holder.children.push(second);
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
        // The document's encoding, which applies when no accept-charset
        // label is recognised.
        characterSet: options.characterSet === undefined ? 'UTF-8' : options.characterSet,
        createElement: tagName => element(tagName),
        querySelector: selector => query(document, selector)[0] || null,
        querySelectorAll: selector => query(document, selector)
    };

    // Host timers the test advances by hand, and window listeners the
    // test dispatches by hand.
    const timers = new Map();
    let timerSeq = 0;
    const windowListeners = {};
    const window = {
        WeakMap: options.noWeakMap ? undefined : WeakMap,
        setTimeout(fn, delay) {
            if (options.timerRefused) {
                throw new Error('timer refused');
            }
            timerSeq += 1;
            timers.set(timerSeq, {fn, delay});
            return timerSeq;
        },
        clearTimeout(id) { timers.delete(id); },
        addEventListener(type, fn) { (windowListeners[type] = windowListeners[type] || []).push(fn); },
        removeEventListener(type, fn) {
            const list = windowListeners[type] || [];
            const index = list.indexOf(fn);
            if (index !== -1) {
                list.splice(index, 1);
            }
        },
        XMLHttpRequest: function XMLHttpRequest() { },
        CustomEvent: function CustomEvent(type, init) {
            const event = {type, bubbles: false, cancelable: false, defaultPrevented: false, detail: null};
            if (init) {
                event.bubbles = Boolean(init.bubbles);
                event.cancelable = Boolean(init.cancelable);
                event.detail = init.detail;
            }
            event.preventDefault = () => {
                if (event.cancelable) { event.defaultPrevented = true; }
            };
            return event;
        },
        URL,
        URLSearchParams,
        TextDecoder: options.noTextDecoder ? undefined : TextDecoder,
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
    vm.runInNewContext(readModuleSource('paste/ui/form.js'), {
        window, document, Array, console,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.form');
            assert.equal(deps.length, 2);
            assert.equal(deps[0], 'paste.io');
            assert.equal(deps[1], 'paste.event');
            // A Subscription attaches through the element's own listener
            // registration — the same binding addEventListener would make.
            const event = {Event: {Subscription: function (type, el, fn) {
                el.addEventListener(type, fn);
                this.attach = () => {};
                this.detach = () => el.removeEventListener(type, fn);
                this.dispose = () => el.removeEventListener(type, fn);
            }}};
            factory(exports, io, event);
        }}
    });
    // The module probes FormData's submitter argument during evaluation;
    // instances a submit creates start at index 0 for the tests.
    formDataInstances.length = 0;
    // Forms present when the module runs are enhanced during evaluation.
    const fireTimers = () => {
        const due = Array.from(timers.values());
        timers.clear();
        due.forEach(timer => timer.fn());
    };
    const dispatchWindow = type => (windowListeners[type] || []).slice().forEach(fn => fn({type}));
    const windowListenerCount = () => Object.values(windowListeners).reduce((sum, list) => sum + list.length, 0);
    return {exports, io, ioCalls, window, document, target, form, unmarked, second, inner, element, submitEvent, FakeFormData, formDataInstances,
        timers, fireTimers, dispatchWindow, windowListenerCount};
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
    assert.deepEqual(call.data.list, [['email', 'a b@example.test'], ['go', 'Send']]);
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

test('an HTML response from a cross-origin final URL is not placed and not replayed', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    // A real innerHTML write here would detach the form — build the DOM it
    // claimed to represent instead: existing content beside the form and a
    // control inside it, so the assertions name real node identity.
    const original = f.element('p');
    f.target.appendChild(original);
    const input = f.element('input');
    f.form.appendChild(input);
    submit(f, {name: 'go', value: 'Send'});
    // The response arrived, but its final URL is foreign — its markup is
    // never placed, and a transmitted POST does not silently replay.
    f.ioCalls[0].request.reply(200, 'text/html', '<p>other</p>', 'https://other.test/landing');
    assert.equal(f.target.innerHTML, '', 'foreign markup is never inserted');
    assert.equal(f.target.children.includes(original), true);
    assert.equal(f.form.parentElement, f.target);
    assert.equal(f.form.children.includes(input), true);
    assert.equal(f.form.submitted, undefined);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'response');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1);
});

test('an HTML response with an empty responseURL fails as unplaceable', () => {
    const f = fixture();
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>other</p>', '');
    assert.equal(f.target.innerHTML, '');
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1);
});

test('an HTML response redirected within the page origin is placed normally', () => {
    const f = fixture();
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>redirected</p>', 'https://example.test/elsewhere');
    assert.equal(f.target.innerHTML, '<p>redirected</p>');
    assert.equal(f.form.submitted, undefined);
});

test('a 200 application/json response produces one POST and no replay', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f, {name: 'go', value: 'Send'});
    f.ioCalls[0].request.reply(200, 'application/json', '{}');
    // One transmitted POST, zero native replays — the response path obeys
    // the same replay rule as transport failures.
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.prototypeSubmitted, undefined);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'response');
    // The default feedback lands inside the form, focused, and entered
    // values stay untouched.
    const notice = f.form.children.find(c => c.className === 'paste-ui-form-failure');
    assert.ok(notice);
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.getAttribute('tabindex'), '-1');
    assert.equal(notice.focused, true);
    assert.equal(notice.textContent, 'We could not confirm your submission. It may have been received. Please check before submitting again.');
    // The released form submits again normally.
    const next = submit(f);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('an uncertain post failure releases the form and shows the default notice', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f);
    const request = f.ioCalls[0].request;
    request.onerror();
    request.onerror();
    request.onabort();
    // One notification and one cleanup for all three terminal events —
    // the request may have delivered, so no replay, and the visitor gets
    // the honest "may have been received" notice.
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.prototypeSubmitted, undefined);
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'error');
    const notice = f.form.children.find(c => c.className === 'paste-ui-form-failure');
    assert.ok(notice, 'an unhandled POST failure must surface a visible notice');
    assert.equal(notice.getAttribute('role'), 'alert');
    assert.equal(notice.focused, true);
    // The released form submits again normally.
    const next = submit(f);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('a status-0 readystatechange settles nothing — the terminal event names the cause', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f);
    const call = f.ioCalls[0];
    // paste.io's callback fires from readystatechange(4, 0) BEFORE the
    // browser's terminal event — it must not consume the failure.
    call.onFailure('', 0, call.request);
    assert.equal(failures.length, 0);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    call.request.ontimeout();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'timeout');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    // A trailing event on the settled request is inert.
    call.request.onerror();
    assert.equal(failures.length, 1);
});

test('a status-0 reply followed by error names the transport failure', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f);
    const call = f.ioCalls[0];
    call.onFailure('', 0, call.request);
    call.request.onerror();
    call.request.onabort();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'error');
});

test('an idempotent-declared form resubmits natively on an uncertain failure', () => {
    const f = fixture();
    f.form.setAttribute('data-paste-form-idempotent', '');
    const submitter = {name: 'go', value: 'Send'};
    submit(f, submitter);
    f.ioCalls[0].request.onerror();
    assert.equal(f.form.submitted, 1);
    assert.equal(f.form.lastSubmitter, submitter);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a get resubmits natively on an uncertain failure — replay cannot double it', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    f.ioCalls[0].request.ontimeout();
    assert.equal(f.form.submitted, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('a canceled failure event owns the failure — busy already cleared inside the listener', () => {
    const f = fixture();
    f.form.setAttribute('data-paste-form-idempotent', '');
    const observed = [];
    f.form.addEventListener('paste.ui.form:failed', event => {
        // Busy state clears before dispatch — a listener may start a new
        // submission without meeting the in-flight guard.
        observed.push(f.target.hasAttribute('aria-busy'));
        event.preventDefault();
    });
    submit(f);
    f.ioCalls[0].request.ontimeout();
    assert.deepEqual(observed, [false]);
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 0,
        'a handled failure gets no default notice');
    const next = submit(f);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
});

test('late events from a settled request leave a newer submission alone', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f);
    const first = f.ioCalls[0].request;
    first.onerror();
    assert.equal(failures.length, 1);
    // Visitor retries — a second request now owns the busy state.
    submit(f);
    assert.equal(f.ioCalls.length, 2);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    // A trailing event on the old request must not notify again or strip
    // the newer request's busy state.
    first.onabort();
    first.onload();
    assert.equal(failures.length, 1);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
});

test('repeated failures keep exactly one module-created notice', () => {
    const f = fixture();
    // A server-rendered validation message and the visitor's typed value —
    // the failure path must leave both standing.
    const validation = f.element('p');
    validation.className = 'field-error';
    validation.setAttribute('role', 'alert');
    validation.textContent = 'Enter a valid email address';
    f.form.appendChild(validation);
    const input = f.element('input');
    input.setAttribute('name', 'email');
    input.value = 'a b@example.test';
    f.form.appendChild(input);
    submit(f);
    f.ioCalls[0].request.onerror();
    submit(f);
    f.ioCalls[1].request.ontimeout();
    const notices = f.form.children.filter(c => c.className === 'paste-ui-form-failure');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].detail, undefined);
    assert.equal(f.ioCalls.length, 2);
    // Entered values and the server-rendered message survive both failures —
    // by node identity, not a field snapshot taken before the fact.
    assert.equal(f.form.children.includes(validation), true);
    assert.equal(validation.textContent, 'Enter a valid email address');
    assert.equal(f.form.children.includes(input), true);
    assert.equal(input.value, 'a b@example.test');
    // And the resubmission still carries what the visitor typed.
    assert.equal(f.formDataInstances[1].list.some(([n, v]) => n === 'email' && v === 'a b@example.test'), true);
});

test('the background request timeout only honors decimal digits in the XHR range', () => {
    // The deadline runs on the module's timer; a declared value past the
    // longest delay a host timer holds runs at that limit.
    const cases = [
        [undefined, 30000], ['', 30000], [' ', 30000], ['later', 30000],
        ['-1', 30000], ['0.5', 30000], ['1.5', 30000], ['1e3', 30000],
        ['0x10', 30000], ['4294967296', 30000],
        ['0', null], ['1', 1], ['45000', 45000], ['2147483647', 2147483647],
        ['2147483648', 2147483647], ['4294967295', 2147483647]
    ];
    cases.forEach(([value, expected]) => {
        const f = fixture();
        if (value !== undefined) {
            f.form.setAttribute('data-paste-form-timeout', value);
        }
        submit(f);
        const armed = Array.from(f.timers.values());
        assert.deepEqual(armed.map(timer => timer.delay), expected === null ? [] : [expected],
            'data-paste-form-timeout=' + JSON.stringify(value));
        // No XHR timeout is assigned after send — an engine may ignore it.
        assert.equal(f.ioCalls[0].request.timeout, undefined);
    });
});

test('a load with no answer is the error its skipped callback never delivered', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event); });
    submit(f);
    const request = f.ioCalls[0].request;
    // Old paste.io threw inside readystatechange on a status-0 reply —
    // load fires with no callback ever having run.
    request.onload();
    request.onload();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].detail.reason, 'error');
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a completed response on load is classified by the normal response path', () => {
    const f = fixture();
    submit(f);
    const request = f.ioCalls[0].request;
    // Old paste.io threw before calling either callback; the load event
    // then presents the completed response through respond once.
    request.responseText = '<p>recovered</p>';
    request.status = 200;
    request.getResponseHeader = () => 'text/html';
    request.onload();
    assert.equal(f.target.innerHTML, '<p>recovered</p>');
    request.onload();
    assert.equal(f.target.innerHTML, '<p>recovered</p>');
});

test('a request paste.io could not start is left to submit natively, never busy', () => {
    const f = fixture({nullRequest: true});
    let busySeen = false;
    const set = f.target.setAttribute;
    f.target.setAttribute = (k, v) => { if (k === 'aria-busy') { busySeen = true; } set(k, v); };
    const event = submit(f);
    assert.equal(event.prevented, 0, 'the native submit was taken over with no request behind it');
    assert.equal(f.form.submitted, undefined, 'a synthetic resubmit doubled the native one');
    assert.equal(f.ioCalls.length, 0);
    assert.equal(busySeen, false, 'busy state was committed for a request that never started');
});

test('a throwing FormData leaves the submit native and the form free', () => {
    const f = fixture({formDataThrowsOnSubmit: true});
    const event = submit(f);
    assert.equal(event.prevented, 0, 'the submit was prevented with nothing sent');
    assert.equal(f.target.hasAttribute('aria-busy'), false, 'a FormData throw left the target busy');
    assert.equal(f.ioCalls.length, 0);
});

test('a throwing paste.io leaves the submit native and a later submit still runs', () => {
    const f = fixture({ioThrows: true});
    const first = submit(f);
    assert.equal(first.prevented, 0);
    assert.equal(f.target.hasAttribute('aria-busy'), false, 'an io throw left the target busy');
    const second = submit(f);
    assert.equal(second.prevented, 0, 'the in-flight guard swallowed a later submit');
});

test('a get that paste.io refuses is left native too', () => {
    const f = fixture({ioThrows: true});
    f.form.setAttribute('method', 'get');
    const event = submit(f);
    assert.equal(event.prevented, 0);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('an authored tabindex on a placed alert is kept', () => {
    const f = fixture();
    const alert = f.element('p');
    alert.setAttribute('role', 'alert');
    alert.setAttribute('tabindex', '0');
    f.target.parsed = [alert];
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p role="alert" tabindex="0">Done</p>');
    assert.equal(alert.getAttribute('tabindex'), '0', 'the authored tabindex was overwritten');
    assert.equal(alert.focused, true);
});

test('a placed status region without a tabindex becomes focusable', () => {
    const f = fixture();
    const status = f.element('p');
    status.setAttribute('role', 'status');
    f.target.parsed = [status];
    submit(f);
    f.ioCalls[0].request.reply(200, 'text/html', '<p role="status">Saved</p>');
    assert.equal(status.getAttribute('tabindex'), '-1');
    assert.equal(status.focused, true);
});

test('host constructors are captured once, at define time', () => {
    const f = fixture();
    f.window.FormData = () => { throw new Error('re-read FormData'); };
    f.window.URLSearchParams = undefined;
    f.window.CustomEvent = undefined;
    const event = submit(f);
    assert.equal(event.prevented, 1);
    assert.equal(f.ioCalls[0].data, 'email=a+b%40example.test');
});

test('form source walks FormData without a callback', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/form/form.js'), 'utf8');
    assert.equal(/\.forEach\s*\(/.test(source), false, 'forEach remains in form.js');
    assert.equal(/\bwindow\s*\./.test(source), false, 'a global is read live through window');
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
    f.form.setAttribute('data-paste-form-idempotent', '');
    submit(f);
    // A replay-declared form on a transport failure resubmits natively —
    // through the prototype when requestSubmit is absent.
    f.ioCalls[0].request.onerror();
    assert.equal(f.form.prototypeSubmitted, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a control named requestSubmit shadowing the method still resubmits natively with the submitter', () => {
    const f = fixture();
    const submitter = {name: 'go', value: 'Send'};
    // A form control named "requestSubmit" becomes an own property that hides
    // the method, exactly as a control named "submit" does.
    f.form.requestSubmit = {name: 'requestSubmit'};
    f.form.setAttribute('data-paste-form-idempotent', '');
    submit(f, submitter);
    f.ioCalls[0].request.onerror();
    assert.equal(f.form.submitted, 1);
    assert.equal(f.form.lastSubmitter, submitter);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a throwing requestSubmit falls back to prototype submit exactly once', () => {
    const f = fixture({throwingRequestSubmit: true});
    f.form.setAttribute('data-paste-form-idempotent', '');
    submit(f);
    f.ioCalls[0].request.onerror();
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

test('the source captures builtins instead of re-walking them per call', () => {
    const source = require('fs').readFileSync(
        require('path').join(__dirname, '../modules/form/form.js'), 'utf8');
    assert.ok(!(/Object\.prototype\.hasOwnProperty\.call/).test(source),
        'a builtin is re-walked per call instead of captured once');
});

test('a urlencoded post sends line breaks in names and values as CRLF', () => {
    const f = fixture({fields: [['msg', 'line1\nline2\rline3\r\nline4'], ['a\nb', 'x']]});
    submit(f);
    assert.equal(f.ioCalls[0].data,
        'msg=line1%0D%0Aline2%0D%0Aline3%0D%0Aline4&a%0D%0Ab=x',
        'line breaks were not normalized the way a native submit sends them');
});

test('a get sends line breaks in its query as CRLF', () => {
    const f = fixture({fields: [['msg', 'line1\nline2']]});
    f.form.setAttribute('method', 'get');
    submit(f);
    assert.equal(f.ioCalls[0].url, 'https://example.test/feedback?msg=line1%0D%0Aline2');
});

test('a get that fails synchronously lets its own native submit proceed', () => {
    const f = fixture({syncReply: [500, 'application/json', '{}']});
    f.form.setAttribute('method', 'get');
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => failures.push(event.detail.reason));
    const event = submit(f);
    assert.deepEqual(failures, ['response']);
    assert.equal(event.prevented, 0, 'the native submit was canceled after a failure asked for replay');
    assert.equal(f.form.submitted, undefined, 'a resubmit ran inside the submit dispatch');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a post that fails synchronously keeps the submit and shows the notice', () => {
    const f = fixture({syncReply: [500, 'application/json', '{}']});
    const event = submit(f);
    assert.equal(event.prevented, 1, 'a transmitted post was left to submit again natively');
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1);
});

test('a client that answers synchronously leaves the target free for the next submit', () => {
    const f = fixture({syncReply: [200, 'text/html', '<p>thanks</p>']});
    const first = submit(f);
    assert.equal(first.prevented, 1);
    assert.equal(f.target.hasAttribute('aria-busy'), false, 'a settled request left the target busy');
    const second = submit(f);
    assert.equal(second.prevented, 1);
    assert.equal(f.ioCalls.length, 2, 'the in-flight guard swallowed a submit after a settled request');
});

test('a retry clears the prior failure notice while its new request is pending', () => {
    const f = fixture();
    submit(f);
    f.ioCalls[0].request.onerror();
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1);
    submit(f);
    assert.equal(f.ioCalls.length, 2);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 0,
        'an earlier error must not describe the pending attempt');
});

test('an expired deadline aborts the request on the module timer and reports a timeout', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
    f.form.setAttribute('data-paste-form-timeout', '500');
    submit(f);
    const request = f.ioCalls[0].request;
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    f.fireTimers();
    // The abort the deadline caused is a timeout, never an abort, and is
    // reported once although the request dispatched its abort event.
    assert.equal(request.aborted, 1);
    assert.deepEqual(failures, ['timeout']);
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1);
    assert.equal(f.windowListenerCount(), 0, 'the unload watch ends with the request');
    const next = submit(f);
    assert.equal(next.prevented, 1, 'an expired submit no longer swallows the next one');
    assert.equal(f.ioCalls.length, 2);
});

test('an expired get deadline keeps the documented native replay', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    f.fireTimers();
    assert.equal(f.form.submitted, 1);
    assert.equal(f.ioCalls.length, 1);
});

test('a deadline whose abort throws or dispatches nothing still settles as a timeout', () => {
    [{abortThrows: true}, {abortDispatchesNothing: true}].forEach(options => {
        const f = fixture(options);
        const failures = [];
        f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
        submit(f);
        f.fireTimers();
        assert.deepEqual(failures, ['timeout'], JSON.stringify(options));
        assert.equal(f.target.hasAttribute('aria-busy'), false);
    });
});

test('every settle path clears the deadline and the unload watch', () => {
    const settle = {
        placed: request => request.reply(200, 'text/html', '<p>ok</p>'),
        unplaceable: request => request.reply(200, 'application/json', '{}'),
        error: request => request.onerror(),
        abort: request => request.onabort(),
        clientTimeout: request => request.ontimeout(),
        leaving: request => { request.leave(); request.onabort(); }
    };
    Object.keys(settle).forEach(path => {
        const f = fixture();
        submit(f);
        const request = f.ioCalls[0].request;
        request.leave = () => f.dispatchWindow('beforeunload');
        assert.equal(f.timers.size, 1);
        assert.equal(f.windowListenerCount(), 2);
        settle[path](request);
        assert.equal(f.timers.size, 0, path + ' left its deadline armed');
        assert.equal(f.windowListenerCount(), 0, path + ' left an unload listener');
        assert.equal(f.target.hasAttribute('aria-busy'), false, path);
    });
});

test('an abort once the page began unloading never replays over the navigation', () => {
    ['beforeunload', 'pagehide'].forEach(type => {
        [['post', true], ['get', false], ['post', false]].forEach(([method, idempotent]) => {
            const f = fixture();
            const failures = [];
            f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
            f.form.setAttribute('method', method);
            if (idempotent) {
                f.form.setAttribute('data-paste-form-idempotent', '');
            }
            submit(f);
            f.dispatchWindow(type);
            f.ioCalls[0].request.onabort();
            const label = type + ' ' + method + (idempotent ? ' idempotent' : '');
            assert.deepEqual(failures, ['abort'], label);
            assert.equal(f.form.submitted, undefined, label + ' replayed over the navigation');
            assert.equal(f.form.prototypeSubmitted, undefined, label);
            // The notice stands in for the replay: invisible on a page being
            // left, the honest outcome on one that stays.
            assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1, label);
            assert.equal(f.target.hasAttribute('aria-busy'), false, label);
            // A trailing terminal event stays inert.
            f.ioCalls[0].request.onerror();
            assert.deepEqual(failures, ['abort'], label);
        });
    });
});

test('a handled abort while unloading leaves the failure UX to its listener', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    f.form.addEventListener('paste.ui.form:failed', event => { event.preventDefault(); });
    submit(f);
    f.dispatchWindow('beforeunload');
    f.ioCalls[0].request.onabort();
    assert.equal(f.form.submitted, undefined);
    assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 0);
});

test('an abort while the page stays still fails as an abort with its replay rule', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
    f.form.setAttribute('method', 'get');
    submit(f);
    f.ioCalls[0].request.onabort();
    assert.deepEqual(failures, ['abort']);
    assert.equal(f.form.submitted, 1);
});

test('a transport error after beforeunload still takes the failure path', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
    submit(f);
    f.dispatchWindow('beforeunload');
    f.ioCalls[0].request.onerror();
    assert.deepEqual(failures, ['error']);
});

test('a deadline that expires after beforeunload is still a timeout', () => {
    const f = fixture();
    const failures = [];
    f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
    f.form.setAttribute('data-paste-form-idempotent', '');
    submit(f);
    f.dispatchWindow('beforeunload');
    f.fireTimers();
    assert.deepEqual(failures, ['timeout']);
    assert.equal(f.form.submitted, 1);
});

test('an unload seen by one request does not hold back the next one\'s replay', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    f.dispatchWindow('beforeunload');
    f.ioCalls[0].request.onabort();
    assert.equal(f.form.submitted, undefined);
    // The visitor stayed — another listener held the page — and submits again.
    submit(f);
    f.ioCalls[1].request.onabort();
    assert.equal(f.form.submitted, 1);
});

test('a transport error once the page began unloading never replays over the navigation', () => {
    // An engine may fail the pending request as a network error, not an
    // abort, when a navigation starts — a download link among them.
    ['beforeunload', 'pagehide'].forEach(type => {
        [['post', true], ['get', false]].forEach(([method, idempotent]) => {
            const f = fixture();
            const failures = [];
            f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
            f.form.setAttribute('method', method);
            if (idempotent) {
                f.form.setAttribute('data-paste-form-idempotent', '');
            }
            submit(f);
            f.dispatchWindow(type);
            f.ioCalls[0].request.onerror();
            const label = type + ' ' + method + (idempotent ? ' idempotent' : '');
            assert.deepEqual(failures, ['error'], label);
            assert.equal(f.form.submitted, undefined, label + ' replayed over the navigation');
            assert.equal(f.form.prototypeSubmitted, undefined, label);
            assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 1, label);
        });
    });
});

test('a transport error while the page stays keeps its replay', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    f.ioCalls[0].request.onerror();
    assert.equal(f.form.submitted, 1);
});

// Fires the pending timers armed with one delay, as the host would once
// that much time had passed; the count says how many there were.
function fireDelayed(f, delay) {
    const due = Array.from(f.timers.entries()).filter(([, timer]) => timer.delay === delay);
    due.forEach(([id]) => f.timers.delete(id));
    due.forEach(([, timer]) => timer.fn());
    return due.length;
}

test('a beforeunload the visitor stayed through stops counting once the grace runs out', () => {
    [['get', false], ['post', true]].forEach(([method, idempotent]) => {
        ['abort', 'error'].forEach(reason => {
            const f = fixture();
            const failures = [];
            const label = method + ' ' + reason;
            f.form.addEventListener('paste.ui.form:failed', event => { failures.push(event.detail.reason); });
            f.form.setAttribute('method', method);
            if (idempotent) {
                f.form.setAttribute('data-paste-form-idempotent', '');
            }
            submit(f);
            // The prompt holds every timer; the first one runs once the
            // visitor answered it, and only then does the grace start.
            f.dispatchWindow('beforeunload');
            assert.equal(fireDelayed(f, 0), 1, label + ': no check armed after beforeunload');
            assert.equal(fireDelayed(f, 500), 1, label + ': the grace did not follow the first task');
            // The visitor stayed; a later stop or network failure is not
            // the navigation's.
            f.ioCalls[0].request['on' + reason]();
            assert.deepEqual(failures, [reason], label);
            assert.equal(f.form.submitted, 1, label + ': a failure after the visitor stayed lost its replay');
            assert.equal(f.form.children.filter(c => c.className === 'paste-ui-form-failure').length, 0, label);
            assert.equal(f.timers.size, 0, label + ': a timer outlived the request');
        });
    });
});

test('an abort inside the grace still counts as leaving, and a pagehide ends the grace', () => {
    const inside = fixture();
    inside.form.setAttribute('method', 'get');
    submit(inside);
    inside.dispatchWindow('beforeunload');
    fireDelayed(inside, 0);
    // The navigation's own abort lands before the grace runs out.
    inside.ioCalls[0].request.onabort();
    assert.equal(inside.form.submitted, undefined, 'an abort inside the grace replayed over the navigation');
    assert.equal(inside.timers.size, 0, 'the grace outlived the request');

    const hidden = fixture();
    hidden.form.setAttribute('method', 'get');
    submit(hidden);
    hidden.dispatchWindow('beforeunload');
    fireDelayed(hidden, 0);
    hidden.dispatchWindow('pagehide');
    assert.equal(fireDelayed(hidden, 500), 0, 'a pagehide left the grace armed');
    hidden.ioCalls[0].request.onabort();
    assert.equal(hidden.form.submitted, undefined, 'an abort after pagehide replayed');
});

test('another beforeunload restarts the grace', () => {
    const f = fixture();
    f.form.setAttribute('method', 'get');
    submit(f);
    f.dispatchWindow('beforeunload');
    fireDelayed(f, 0);
    // A second attempt to leave: its prompt holds the timers again.
    f.dispatchWindow('beforeunload');
    assert.equal(fireDelayed(f, 500), 0, 'the first grace survived the second beforeunload');
    assert.equal(fireDelayed(f, 0), 1);
    f.ioCalls[0].request.onabort();
    assert.equal(f.form.submitted, undefined, 'the second attempt to leave was replayed over');
});

test('a settled form keeps no unload listener or deadline between submissions', () => {
    const f = fixture({syncReply: [200, 'text/html', '<p>done</p>']});
    submit(f);
    assert.equal(f.timers.size, 0);
    assert.equal(f.windowListenerCount(), 0);
    const idle = fixture();
    assert.equal(idle.windowListenerCount(), 0, 'an enhanced form with nothing in flight watches nothing');
});

test('a refused timer keeps the background submit and only loses the deadline', () => {
    const f = fixture({timerRefused: true});
    const event = submit(f);
    assert.equal(event.prevented, 1);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    f.ioCalls[0].request.reply(200, 'text/html', '<p>ok</p>');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('the deadline timer is captured at define time', () => {
    const f = fixture();
    f.window.setTimeout = () => { throw new Error('re-read setTimeout'); };
    submit(f);
    assert.equal(f.timers.size, 1);
});

function submitForm(f, form, submitter) {
    const event = f.submitEvent(submitter);
    if (form.listeners.submit) {
        form.listeners.submit(event);
    }
    return event;
}

test('a second form in a busy target is ignored until the owner settles', () => {
    const f = fixture({secondForm: true});
    submit(f);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    const refused = submitForm(f, f.second);
    assert.equal(refused.prevented, 1, 'the second submit is ignored, not sent natively');
    assert.equal(f.ioCalls.length, 1, 'only the owner has a request');
    f.ioCalls[0].request.reply(200, 'text/html', '<p>a</p>');
    assert.equal(f.target.innerHTML, '<p>a</p>');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a target freed by its owner takes the next form\'s submit, and busy lasts until that one settles', () => {
    const f = fixture({secondForm: true});
    submit(f);
    f.ioCalls[0].request.onerror();
    assert.equal(f.target.hasAttribute('aria-busy'), false);
    const next = submitForm(f, f.second);
    assert.equal(next.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
    assert.equal(f.ioCalls[1].url, 'https://example.test/second');
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    // The first form's request is settled: its trailing events neither
    // release the target nor reach the new owner.
    f.ioCalls[0].request.onabort();
    f.ioCalls[0].request.onload();
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
    assert.equal(submit(f).prevented, 1);
    assert.equal(f.ioCalls.length, 2, 'the first form waits for the new owner too');
    f.ioCalls[1].request.reply(200, 'text/html', '<p>b</p>');
    assert.equal(f.target.innerHTML, '<p>b</p>');
    assert.equal(f.target.hasAttribute('aria-busy'), false);
});

test('a failure listener may submit another form into the target it just released', () => {
    const f = fixture({secondForm: true});
    let started = null;
    f.form.addEventListener('paste.ui.form:failed', event => {
        event.preventDefault();
        started = submitForm(f, f.second);
    });
    submit(f);
    f.ioCalls[0].request.ontimeout();
    assert.equal(started.prevented, 1);
    assert.equal(f.ioCalls.length, 2);
    assert.equal(f.target.getAttribute('aria-busy'), 'true');
});

test('nested targets have one owner: neither the inner nor the outer form submits while the other is pending', () => {
    const f = fixture({innerTarget: true});
    submit(f);
    assert.equal(submitForm(f, f.second).prevented, 1);
    assert.equal(f.ioCalls.length, 1);
    assert.equal(f.inner.hasAttribute('aria-busy'), false);
    f.ioCalls[0].request.reply(200, 'text/html', '<p>outer</p>');

    const g = fixture({innerTarget: true});
    submitForm(g, g.second);
    assert.equal(g.inner.getAttribute('aria-busy'), 'true');
    assert.equal(submit(g).prevented, 1);
    assert.equal(g.ioCalls.length, 1);
    assert.equal(g.target.hasAttribute('aria-busy'), false);
    g.ioCalls[0].request.reply(200, 'text/html', '<p>inner</p>');
    assert.equal(g.inner.hasAttribute('aria-busy'), false);
    assert.equal(submit(g).prevented, 1);
    assert.equal(g.ioCalls.length, 2, 'the outer form submits once the inner request settles');
});

test('a form whose encoding is not UTF-8 is left to submit natively', () => {
    const cases = [
        {acceptCharset: 'ISO-8859-1'},
        {acceptCharset: 'Shift_JIS'},
        {acceptCharset: 'windows-1252 utf-8'},
        {acceptCharset: 'unknown-label windows-1252'},
        // A comma separates labels in some engines and not in others.
        {acceptCharset: 'ISO-8859-1,utf-8'},
        {acceptCharset: 'utf-8, ISO-8859-1'},
        // A replacement-encoding label is skipped: the label after it
        // decides.
        {acceptCharset: 'iso-2022-kr windows-1252'},
        {acceptCharset: 'iso-2022-kr', characterSet: 'windows-1252'},
        {characterSet: 'windows-1252'},
        {characterSet: 'Shift_JIS', acceptCharset: ''},
        {acceptCharset: 'utf-8', noTextDecoder: true},
        {acceptCharset: 'ISO-8859-1', method: 'get'},
        {acceptCharset: 'ISO-8859-1', enctype: 'multipart/form-data'}
    ];
    cases.forEach(options => {
        const f = fixture(options);
        if (options.acceptCharset !== undefined) {
            f.form.setAttribute('accept-charset', options.acceptCharset);
        }
        if (options.method) {
            f.form.setAttribute('method', options.method);
        }
        if (options.enctype) {
            f.form.setAttribute('enctype', options.enctype);
        }
        const event = submit(f, {name: 'go', value: 'Send'});
        assert.equal(event.prevented, 0, JSON.stringify(options));
        assert.equal(f.ioCalls.length, 0, JSON.stringify(options));
        assert.equal(f.target.hasAttribute('aria-busy'), false, JSON.stringify(options));
    });
});

test('a form whose submit goes out as UTF-8 is still taken over, UTF-16 included', () => {
    const cases = [
        {},
        {acceptCharset: 'UTF-8'},
        {acceptCharset: ' utf8 '},
        {acceptCharset: 'unknown-label UTF-8 windows-1252'},
        {acceptCharset: 'unknown-label'},
        {acceptCharset: 'utf-8,ISO-8859-1'},
        {acceptCharset: 'utf-8, utf8'},
        // UTF-16 submits as UTF-8.
        {acceptCharset: 'utf-16'},
        {acceptCharset: 'UTF-16BE'},
        {acceptCharset: 'utf-16le windows-1252'},
        {acceptCharset: 'utf-16', characterSet: 'windows-1252'},
        {characterSet: 'UTF-16LE'},
        {characterSet: 'UTF-16BE'},
        {acceptCharset: 'iso-2022-kr'},
        {acceptCharset: 'iso-2022-kr utf-8'},
        {acceptCharset: ''},
        {characterSet: 'Shift_JIS', acceptCharset: 'utf-8'},
        {noTextDecoder: true}
    ];
    cases.forEach(options => {
        const f = fixture(options);
        if (options.acceptCharset !== undefined) {
            f.form.setAttribute('accept-charset', options.acceptCharset);
        }
        const event = submit(f, {name: 'go', value: 'Send'});
        assert.equal(event.prevented, 1, JSON.stringify(options));
        assert.equal(f.ioCalls.length, 1, JSON.stringify(options));
    });
});

test('the text decoder is captured at define time', () => {
    const f = fixture();
    f.form.setAttribute('accept-charset', 'ISO-8859-1');
    f.window.TextDecoder = function () { return {encoding: 'utf-8'}; };
    assert.equal(submit(f).prevented, 0);
});
