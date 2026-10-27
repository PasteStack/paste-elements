/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Prevents a second native submission while the first navigates. Mark an
 * input/button data-prevent-double-submit="true". The first submitter
 * stays successful until native serialization has finished. A canceled
 * submit (including Apply or formhtml submission) owns its own lifetime.
 * Reset and pageshow release only controls this module disabled.
 * @requires paste/event
 * @requires paste/ui/utilities/form-dom
 * @module paste/ui/prevent_double_submit
 */
paste['define']('paste.ui.prevent_double_submit', ['paste.event', 'paste.ui.utilities.form-dom'], function (preventDoubleSubmit, event, formDom) {
    'use strict';

    var $getAttribute = formDom['getAttribute'],
        $w = window,
        formPrototype = $w['HTMLFormElement'] && $w['HTMLFormElement']['prototype'],
        formElements = formPrototype && Object['getOwnPropertyDescriptor'](formPrototype, 'elements').get,
        WeakMapCtor = $w['WeakMap'],
        bound = WeakMapCtor && formElements ? new WeakMapCtor() : null,
        pending = [],
        watchingPages = false,
        bind = event['bind'],
        optedIn = function (element) {
            var value = element['getAttribute']('data-prevent-double-submit');
            return value && value.toLowerCase() === 'true';
        },
        release = function (record) {
            var remaining = record.disabled.length,
                index = pending.indexOf(record);
            $w['clearTimeout'](record.timer);
            while (remaining--) {
                record.disabled[remaining]['disabled'] = false;
            }
            record.disabled.length = 0;
            record.submission = null;
            if (index !== -1) {
                pending.splice(index, 1);
            }
        },
        onSubmit = function (e) {
            var record = this,
                submitter = e['submitter'],
                method = submitter && submitter['hasAttribute']('formmethod') ?
                        submitter['getAttribute']('formmethod') : $getAttribute.call(record.form, 'method');
            // Closing a dialog sends no request and starts no navigation.
            if (e['defaultPrevented'] || (method && method.toLowerCase() === 'dialog')) {
                return;
            }
            if (record.submission) {
                if (!record.submission['defaultPrevented']) {
                    e['preventDefault']();
                    return;
                }
                release(record);
            }
            record.submission = e;
            pending.push(record);
            record.timer = $w['setTimeout'](function () {
                var controls = formElements.call(record.form),
                    remaining = controls.length,
                    control;
                if (e['defaultPrevented']) {
                    release(record);
                    return;
                }
                while (remaining--) {
                    control = controls[remaining];
                    if (optedIn(control) && !control['disabled']) {
                        record.disabled.push(control);
                        control['disabled'] = true;
                    }
                }
            }, 0);
        },
        onReset = function (e) {
            var record = this;
            $w['setTimeout'](function () {
                if (!e['defaultPrevented']) {
                    release(record);
                }
            }, 0);
        },
        onPageShow = function () {
            while (pending.length) {
                release(pending[pending.length - 1]);
            }
        },
        init = function (parent) {
            var root = parent || document,
                elements,
                remaining,
                form,
                record,
                element;
            if (!bound) {
                return;
            }
            if (formDom['nodeType'].call(root) === 1) {
                elements = formDom['querySelectorAll'].call(root, '[data-prevent-double-submit]');
            } else {
                elements = root.querySelectorAll('[data-prevent-double-submit]');
            }
            remaining = elements.length;
            // Include an opted-in root as well as descendants.
            while (remaining >= 0) {
                element = remaining === elements.length ? root : elements[remaining];
                remaining -= 1;
                form = element['form'];
                if (form && optedIn(element) && !bound.get(form)) {
                    if (!watchingPages) {
                        bind('pageshow', $w, onPageShow);
                        watchingPages = true;
                    }
                    record = {form: form, disabled: [], submission: null, timer: null};
                    bound.set(form, record);
                    formDom['addEventListener'].call(form, 'submit', onSubmit.bind(record), false);
                    formDom['addEventListener'].call(form, 'reset', onReset.bind(record), false);
                }
            }
        };

    preventDoubleSubmit['init'] = init;
    init();
});
