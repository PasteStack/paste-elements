/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Save a form to data-autosave-action when fields named by data-ui-autosave
 * change. The first edit, change and blur save immediately; later typing
 * uses a fixed ten-second window. One request per form runs at a time.
 * Success acknowledges only the sent values; later edits remain dirty.
 * Native submission is untouched. Unload is not a delivery guarantee.
 * Successful replies place trusted HTML through the shared innerHTML utility,
 * then bind variables. Server acknowledgment is independent of presentation.
 * data-autosave-timeout declares the request deadline in decimal
 * milliseconds, "0" for none.
 * The data.modules/data-update-* declarations are the original contract;
 * Surface's data.fragments/data-paste-io-reply-fragment-* remain accepted.
 * Fragments use own-key order (integer-like names first); bindings follow.
 * Placed markup does not load assets or initialize other enhancements.
 * @requires paste/event
 * @requires paste/io
 * @requires paste/ui/utilities/form-dom
 * @requires paste/ui/utilities/io-html-fragment
 * @module paste/ui/form/form_autosave
 */
paste['define']('paste.ui.form.form_autosave', ['paste.event', 'paste.io', 'paste.ui.utilities.form-dom', 'paste.ui.utilities.io-html-fragment'], function (autosave, event, io, formDom, fragment) {
    'use strict';

    var $getAttribute = formDom['getAttribute'],
        $hasAttribute = formDom['hasAttribute'],
        $classList = formDom['classList'],
        $w = window,
        $doc = document,
        formPrototype = $w['HTMLFormElement'] && $w['HTMLFormElement']['prototype'],
        formElements = formPrototype && Object['getOwnPropertyDescriptor'](formPrototype, 'elements').get,
        WeakMapCtor = $w['WeakMap'],
        FormDataCtor = $w['FormData'],
        bound = WeakMapCtor && FormDataCtor && formElements ? new WeakMapCtor() : null,
        subscribe = event['bind'],
        // data-autosave-timeout follows data-paste-form-timeout's contract:
        // decimal milliseconds, "0" for no deadline, otherwise the default.
        WHOLE_NUMBER = /^[0-9]+$/,
        DEFAULT_TIMEOUT = 30000,
        timeoutFor = function (form) {
            var declared = $getAttribute.call(form, 'data-autosave-timeout'),
                timeout;
            if (declared === '0') {
                return 0;
            }
            if (declared === null || !WHOLE_NUMBER.test(declared)) {
                return DEFAULT_TIMEOUT;
            }
            timeout = Number(declared);
            return timeout >= 1 && timeout <= 4294967295 ? timeout : DEFAULT_TIMEOUT;
        },
        snapshot = function (record) {
            var controls = formElements.call(record.form),
                remaining = controls.length,
                index = 0,
                element,
                options,
                count,
                optionIndex,
                value,
                files,
                file,
                values = [];
            // Native form order matters for repeated field names.
            while (remaining--) {
                element = controls[index];
                index += 1;
                if (record.names[element['name']]) {
                    value = element['value'];
                    if (element['type'] === 'radio' || element['type'] === 'checkbox') {
                        value = element['checked'] ? value : null;
                    } else if (element['type'] === 'select-multiple') {
                        value = [];
                        options = element['options'];
                        count = options.length;
                        optionIndex = 0;
                        while (count--) {
                            if (options[optionIndex]['selected']) {
                                value.push(options[optionIndex]['value']);
                            }
                            optionIndex += 1;
                        }
                    } else if (element['type'] === 'file') {
                        value = [];
                        files = element['files'];
                        count = files.length;
                        optionIndex = 0;
                        while (count--) {
                            file = files[optionIndex];
                            optionIndex += 1;
                            value.push([file['name'], file['size'], file['type'], file['lastModified']]);
                        }
                    }
                    values.push([element['name'], element['disabled'], value]);
                }
            }
            return JSON['stringify'](values);
        },
        reflectDirty = function (record, current) {
            $classList.call(record.form).toggle('not-autosaved', current !== record.saved || record.unacknowledged);
        },
        send,
        schedule = function (record) {
            if (record.timer === null) {
                record.timer = $w['setTimeout'](function () {
                    record.timer = null;
                    send(record);
                }, 10000);
            }
        },
        onEdit = function (e) {
            var record = this,
                current = snapshot(record),
                immediate = record.first || e.type === 'change' || e.type === 'blur';
            record.first = false;
            reflectDirty(record, current);
            if (record.pending || current === record.saved) {
                return;
            }
            if (immediate) {
                send(record);
            } else {
                schedule(record);
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                forms,
                remaining,
                form,
                record,
                names,
                count,
                controls,
                element;
            if (!bound) {
                return;
            }
            if (formDom['nodeType'].call(root) === 1) {
                forms = formDom['querySelectorAll'].call(root, 'form[data-ui-autosave]');
            } else {
                forms = root.querySelectorAll('form[data-ui-autosave]');
            }
            remaining = forms.length;
            while (remaining >= 0) {
                form = remaining === forms.length ? root : forms[remaining];
                remaining -= 1;
                if (formDom['nodeType'].call(form) === 1 && formDom['tagName'].call(form) === 'FORM' && $hasAttribute.call(form, 'data-ui-autosave') &&
                        $getAttribute.call(form, 'data-autosave-action')) {
                    record = bound.get(form);
                    if (!record) {
                        names = $getAttribute.call(form, 'data-ui-autosave').split(',');
                        record = {
                            form: form,
                            names: Object['create'](null),
                            pending: false,
                            first: true,
                            timer: null,
                            unacknowledged: $getAttribute.call(form, 'action') === $getAttribute.call(form, 'data-autosave-action')
                        };
                        count = names.length;
                        while (count--) {
                            record.names[names[count].trim()] = true;
                        }
                        record.saved = snapshot(record);
                        $classList.call(form).add('not-autosaving');
                        reflectDirty(record, record.saved);
                        bound.set(form, record);
                    }
                    controls = formElements.call(form);
                    count = controls.length;
                    while (count--) {
                        element = controls[count];
                        if (record.names[element['name']] && !bound.get(element)) {
                            bound.set(element, record);
                            subscribe('input', element, onEdit, record);
                            subscribe('change', element, onEdit, record);
                            subscribe('blur', element, onEdit, record);
                        }
                    }
                }
            }
        };

    send = function (record) {
        var sent,
            data,
            request,
            action,
            settled = false,
            finish,
            failed;
        if (record.pending) {
            return;
        }
        $w['clearTimeout'](record.timer);
        record.timer = null;
        if (!$doc['contains'](record.form)) {
            return;
        }
        sent = snapshot(record);
        reflectDirty(record, sent);
        action = $getAttribute.call(record.form, 'data-autosave-action');
        if (sent === record.saved || !action) {
            return;
        }
        finish = function (response, status) {
            var successful,
                current;
            if (settled) {
                return;
            }
            settled = true;
            record.pending = false;
            $classList.call(record.form).remove('autosaving');
            $classList.call(record.form).add('not-autosaving');
            successful = status === 200 && response && response['meta'] &&
                response['meta']['code'] === 200 && response['data'] && typeof response['data'] === 'object';
            try {
                if (successful) {
                    record.saved = sent;
                    record.unacknowledged = false;
                    if ($doc['contains'](record.form)) {
                        fragment['apply'](response['data']);
                    }
                }
            } finally {
                // A refused optional HTML sink cannot lose edits made in flight.
                current = snapshot(record);
                reflectDirty(record, current);
                if (successful && current !== record.saved && $doc['contains'](record.form)) {
                    schedule(record);
                }
            }
        };
        failed = function () {
            finish(null, 0);
        };
        record.pending = true;
        try {
            data = new FormDataCtor(record.form);
            request = io['open']('POST', action, finish, finish);
            if (!request) {
                failed();
                return;
            }
            request['onerror'] = failed;
            request['onabort'] = failed;
            request['ontimeout'] = failed;
            request['timeout'] = timeoutFor(record.form);
            $classList.call(record.form).remove('not-autosaving');
            $classList.call(record.form).add('autosaving');
            request['send'](data);
        } catch (requestError) {
            failed();
        }
    };

    autosave['init'] = init;
    init();
});
