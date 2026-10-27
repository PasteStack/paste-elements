/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Original JSON form submission, generalized to form.paste-ui-apply.
 * POST successful controls; show success.message or error.message and mark
 * error.param's field. Each form owns its request, messages and labels.
 * Native forms remain the fallback when the declared submission is unsupported.
 * A transmitted request is never replayed automatically.
 * data-paste-form-timeout declares the request deadline in decimal
 * milliseconds, "0" for none.
 * @requires paste/event
 * @requires paste/io
 * @requires paste/guid
 * @requires paste/ui/form/form_validity
 * @requires paste/ui/utilities/form-dom
 * @module paste/ui/form/form_apply
 */
paste['define']('paste.ui.form.form_apply', ['paste.event', 'paste.io', 'paste.guid', 'paste.ui.form.form_validity', 'paste.ui.utilities.form-dom'], function (apply, event, io, guid, form, formDom) {
    'use strict';

    var $getAttribute = formDom['getAttribute'],
        $setAttribute = formDom['setAttribute'],
        $hasAttribute = formDom['hasAttribute'],
        $removeAttribute = formDom['removeAttribute'],
        $insertBefore = formDom['insertBefore'],
        $classList = formDom['classList'],
        $firstChild = formDom['firstChild'],
        $w = window,
        $doc = document,
        FormDataCtor = $w['FormData'],
        Params = $w['URLSearchParams'],
        WeakMapCtor = $w['WeakMap'],
        prototype = $w['HTMLFormElement'] && $w['HTMLFormElement']['prototype'],
        elements = prototype && Object['getOwnPropertyDescriptor'](prototype, 'elements').get,
        valid = prototype && prototype['checkValidity'],
        bound = WeakMapCtor && FormDataCtor && Params && elements && typeof valid === 'function' ? new WeakMapCtor() : null,
        takesSubmitter,
        lineBreaks = /\r\n|\r|\n/g,
        // data-paste-form-timeout shares form_html's contract: decimal
        // milliseconds, "0" for no deadline, otherwise the default.
        WHOLE_NUMBER = /^[0-9]+$/,
        DEFAULT_TIMEOUT = 30000,
        timeoutFor = function (element) {
            var declared = $getAttribute.call(element, 'data-paste-form-timeout'),
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
        supportsSubmitter = function () {
            var probe = $doc['createElement']('form'),
                button = $doc['createElement']('button');
            button['name'] = 'probe';
            probe['appendChild'](button);
            try {
                return new FormDataCtor(probe, button)['has']('probe');
            } catch (unsupported) {
                return false;
            }
        },
        notifyHidden = function (field) {
            var change;
            if (field['type'] === 'hidden') {
                change = new event['Event'](field, 'change');
                change['fire']();
                change['dispose']();
            }
        },
        fieldLabel = function (field) {
            var label = field['previousElementSibling'];
            return label && label['tagName'] === 'LABEL' &&
                label['htmlFor'] === field['id'] ? label : null;
        },
        textField = function (field) {
            return field['tagName'] === 'TEXTAREA' || (field['tagName'] === 'INPUT' &&
                /^(text|email|password|search|tel|url|number)$/.test(field['type']));
        },
        reflectField = function (field, focused) {
            var label;
            if (textField(field)) {
                label = fieldLabel(field);
                if (label) {
                    // Keep the label's accessible name while hiding its ink.
                    label['classList'].toggle('paste-ui-apply-label-hidden', focused || field['value'] !== '');
                }
            }
        },
        onFocus = function (e) {
            var field = e['target'];
            reflectField(field, e.type === 'focusin');
            if (field['value'] && field['parentElement']) {
                $classList.call(field['parentElement']).remove('paste-ui-apply-error');
            }
        },
        message = function (record, text, successful) {
            var node = record.message;
            if (!node) {
                node = $doc['createElement']('p');
                $insertBefore.call(record.form, node, $firstChild.call(record.form));
                record.message = node;
            }
            node['className'] = successful ? 'paste-ui-apply-success' : 'paste-ui-apply-failure';
            node['setAttribute']('role', successful ? 'status' : 'alert');
            node['textContent'] = text;
        },
        clearFields = function (record) {
            var controls = elements.call(record.form),
                count = controls.length,
                field;
            while (count--) {
                field = controls[count];
                if (textField(field) || field['type'] === 'file') {
                    field['value'] = '';
                    reflectField(field, false);
                }
                if (field['parentElement']) {
                    $classList.call(field['parentElement']).remove('paste-ui-apply-error');
                }
                // Preserve authored tokens; keep the original renewal notification.
                notifyHidden(field);
            }
        },
        markError = function (record, param) {
            var controls = elements.call(record.form),
                count = controls.length,
                field;
            while (count--) {
                field = controls[count];
                if (field['parentElement']) {
                    $classList.call(field['parentElement']).remove('paste-ui-apply-error');
                }
            }
            count = controls.length;
            while (count--) {
                field = controls[count];
                if (field['parentElement'] && typeof param === 'string' &&
                        field['name'].toLowerCase() === param.toLowerCase()) {
                    $classList.call(field['parentElement']).add('paste-ui-apply-error');
                }
            }
        },
        onSubmit = function (e) {
            var record = this,
                element = record.form,
                submitter = e['submitter'],
                method = submitter && submitter['hasAttribute']('formmethod') ?
                        submitter['getAttribute']('formmethod') : $getAttribute.call(element, 'method'),
                target = submitter && submitter['hasAttribute']('formtarget') ?
                        submitter['getAttribute']('formtarget') : $getAttribute.call(element, 'target'),
                enctype = submitter && submitter['hasAttribute']('formenctype') ?
                        submitter['getAttribute']('formenctype') : $getAttribute.call(element, 'enctype'),
                action = submitter && submitter['hasAttribute']('formaction') ?
                        submitter['getAttribute']('formaction') : $getAttribute.call(element, 'action'),
                charset = $getAttribute.call(element, 'accept-charset') || $doc['characterSet'],
                fields,
                params,
                iterator,
                step,
                value,
                request,
                settled = false,
                finish,
                failed;
            if (e['defaultPrevented']) {
                return;
            }
            if (record.pending || $getAttribute.call(element, 'data-not-allowed') === 'true') {
                e['preventDefault']();
                return;
            }
            if (/(^|\s)noreferrer(\s|$)/i.test($getAttribute.call(element, 'rel') || '') ||
                    (!method || method.toLowerCase() !== 'post') || (target && target.toLowerCase() !== '_self') ||
                    (!target && $doc['querySelector']('base[target]')) || !/^utf-8$/i.test(charset) ||
                    submitter === undefined || (submitter && (!takesSubmitter || submitter['type'] === 'image')) ||
                    (enctype && enctype !== 'application/x-www-form-urlencoded' && enctype !== 'multipart/form-data')) {
                return;
            }
            if (!$hasAttribute.call(element, 'novalidate') && !(submitter && submitter['formNoValidate']) && !valid.call(element)) {
                e['preventDefault']();
                return;
            }
            finish = function (result, status) {
                var success = result && result['success'],
                    error = result && result['error'];
                if (settled) {
                    return;
                }
                settled = true;
                record.pending = false;
                $classList.call(element).remove('paste-ui-apply-busy');
                $removeAttribute.call(element, 'aria-busy');
                if (status >= 200 && status < 300 && success && typeof success['message'] === 'string') {
                    clearFields(record);
                    message(record, success['message'], true);
                } else {
                    markError(record, error && error['param']);
                    message(record, error && typeof error['message'] === 'string' ? error['message'] :
                            'The submission could not be confirmed. Please try again.', false);
                }
            };
            failed = function () { finish(null); };
            record.pending = true;
            try {
                fields = new FormDataCtor(element, submitter || undefined);
                if (!fields['has']('_')) {
                    fields['append']('_', guid['Guid']['create']());
                }
                params = fields;
                if (enctype !== 'multipart/form-data') {
                    params = new Params();
                    iterator = fields['entries']();
                    step = iterator['next']();
                    while (!step['done']) {
                        value = step['value'][1];
                        params['append'](step['value'][0].replace(lineBreaks, '\r\n'),
                            (typeof value === 'string' ? value : value['name']).replace(lineBreaks, '\r\n'));
                        step = iterator['next']();
                    }
                    params = params.toString();
                }
                request = io['open']('POST', action || $w['location']['href'], finish, finish);
            } catch (unsupported) {
                record.pending = false;
                return;
            }
            if (!request) {
                record.pending = false;
                return;
            }
            e['preventDefault']();
            record.pending = true;
            $classList.call(element).add('paste-ui-apply-busy');
            $setAttribute.call(element, 'aria-busy', 'true');
            request['onerror'] = failed;
            request['onabort'] = failed;
            request['ontimeout'] = failed;
            request['timeout'] = timeoutFor(element);
            try {
                if (typeof params === 'string') {
                    request['setRequestHeader']('Content-Type', 'application/x-www-form-urlencoded');
                }
                request['send'](params);
            } catch (sendError) {
                failed();
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                forms,
                count,
                element,
                record,
                controls,
                remaining;
            if (!bound) {
                return;
            }
            form['init'](root);
            if (formDom['nodeType'].call(root) === 1) {
                forms = formDom['querySelectorAll'].call(root, 'form.paste-ui-apply');
            } else {
                forms = root.querySelectorAll('form.paste-ui-apply');
            }
            count = forms.length;
            while (count >= 0) {
                element = count === forms.length ? root : forms[count];
                count -= 1;
                if (formDom['nodeType'].call(element) === 1 && formDom['tagName'].call(element) === 'FORM' && $classList.call(element).contains('paste-ui-apply') && !bound.has(element)) {
                    if (takesSubmitter === undefined) {
                        takesSubmitter = supportsSubmitter();
                    }
                    record = {form: element, pending: false, message: null};
                    bound.set(element, record);
                    formDom['addEventListener'].call(element, 'submit', onSubmit.bind(record), false);
                    formDom['addEventListener'].call(element, 'focusin', onFocus, false);
                    formDom['addEventListener'].call(element, 'focusout', onFocus, false);
                    controls = elements.call(element);
                    remaining = controls.length;
                    while (remaining--) {
                        reflectField(controls[remaining], false);
                        notifyHidden(controls[remaining]);
                    }
                }
            }
        };

    apply['init'] = init;
    init();
});
