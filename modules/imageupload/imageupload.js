/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Upload the first chosen file to data-image-upload-action, then update
 * the paired hidden URI, preview and message in the same form. Pairing
 * is authored with data-image-upload-for="file-input-id". The ordinary
 * file input and form remain usable without this enhancement.
 * data-image-upload-timeout declares the request deadline in decimal
 * milliseconds, "0" for none.
 * @requires paste/event
 * @requires paste/io
 * @requires paste/ui/utilities/form-dom
 * @module paste/ui/imageupload
 */
paste['define']('paste.ui.imageupload', ['paste.event', 'paste.io', 'paste.ui.utilities.form-dom'], function (imageupload, event, io, formDom) {
    'use strict';

    var $doc = document,
        $w = window,
        formPrototype = $w['HTMLFormElement'] && $w['HTMLFormElement']['prototype'],
        formElements = formPrototype && Object['getOwnPropertyDescriptor'](formPrototype, 'elements').get,
        WeakMapCtor = $w['WeakMap'],
        FormDataCtor = $w['FormData'],
        bound = WeakMapCtor && FormDataCtor && formElements ? new WeakMapCtor() : null,
        subscribe = event['bind'],
        // data-image-upload-timeout follows data-paste-form-timeout's
        // contract: decimal milliseconds, "0" for no deadline, otherwise the
        // default.
        WHOLE_NUMBER = /^[0-9]+$/,
        DEFAULT_TIMEOUT = 30000,
        timeoutFor = function (element) {
            var declared = element['getAttribute']('data-image-upload-timeout'),
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
        LOADING = 'data-image-upload-loading',
        ERROR = 'data-image-upload-error-message',
        clearLoading = function (record) {
            if (record.request) {
                return;
            }
            record.field['removeAttribute'](LOADING);
            record.message['removeAttribute'](LOADING);
        },
        updatePreview = function () {
            var record = this,
                value = record.uri['value'],
                prefix = record.preview['getAttribute']('data-image-url-prefix') || '',
                src = value ? prefix.replace(/\/$/, '') + (prefix && value.charAt(0) !== '/' ? '/' : '') + value : record.defaultSrc;
            if (src === record.preview['getAttribute']('src')) {
                if (record.preview['complete']) {
                    clearLoading(record);
                }
            } else if (src) {
                record.preview['setAttribute']('src', src);
            } else {
                record.preview['removeAttribute']('src');
                clearLoading(record);
            }
        },
        previewFinished = function () {
            // A previous preview may finish while a newer upload is pending.
            if (!this.request && this.preview['complete']) {
                clearLoading(this);
            }
        },
        setUri = function (record, value) {
            var change = $doc['createEvent']('HTMLEvents');
            record.uri['value'] = value;
            change['initEvent']('change', true, true);
            record.uri['dispatchEvent'](change);
        },
        upload = function () {
            var record = this,
                field = record.field,
                file = field['files'] && field['files'][0],
                action = field['getAttribute']('data-image-upload-action'),
                name = field['getAttribute']('data-image-upload-param') || field['name'],
                previous,
                request,
                data,
                settled = false,
                finish = function (response, status) {
                    var successful,
                        detail;
                    if (settled || record.request !== request) {
                        return;
                    }
                    settled = true;
                    record.request = null;
                    successful = status === 200 && response && response['meta'] &&
                        response['meta']['code'] === 200 && typeof response['data'] === 'string';
                    if (successful) {
                        record.message['removeAttribute'](ERROR);
                        setUri(record, response['data']);
                    } else {
                        detail = response && response['meta'] && response['meta']['error_detail'];
                        record.message['setAttribute'](ERROR, typeof detail === 'string' ? detail : 'Error uploading image');
                        clearLoading(record);
                        setUri(record, '');
                    }
                },
                failed = function () {
                    finish(null, 0);
                };
            if (!file || !action || !name) {
                return;
            }
            previous = record.request;
            record.request = null;
            if (previous) {
                previous['abort']();
            }
            record.message['removeAttribute'](ERROR);
            try {
                data = new FormDataCtor();
                data['append'](name, file);
                request = io['open']('POST', action, finish, finish);
                record.request = request;
                if (!request) {
                    failed();
                    return;
                }
                request['onerror'] = failed;
                request['onabort'] = failed;
                request['ontimeout'] = failed;
                request['timeout'] = timeoutFor(field);
                field['setAttribute'](LOADING, 'image-upload-loading');
                record.message['setAttribute'](LOADING, 'image-upload-loading');
                request['send'](data);
            } catch (requestError) {
                // Configuration/network setup failed before a reply existed.
                record.request = request;
                failed();
            }
        },
        bindField = function (field, form) {
            var related,
                remaining,
                element,
                record;
            form = form || field['form'];
            if (!bound || !form || !field['id'] || bound.get(field)) {
                return;
            }
            record = {field: field, request: null};
            if (formDom['nodeType'].call(form) === 1) {
                related = formDom['querySelectorAll'].call(form, '[data-image-upload-for]');
            } else {
                related = form.querySelectorAll('[data-image-upload-for]');
            }
            remaining = related.length;
            while (remaining--) {
                element = related[remaining];
                if (element['getAttribute']('data-image-upload-for') === field['id']) {
                    if (element['hasAttribute']('data-image-upload-preview')) {
                        record.preview = element;
                    } else if (element['hasAttribute']('data-image-upload-uri')) {
                        record.uri = element;
                    } else if (element['hasAttribute']('data-image-upload-message')) {
                        record.message = element;
                    }
                }
            }
            if (!record.preview || !record.uri || !record.message) {
                return;
            }
            record.defaultSrc = record.preview['getAttribute']('data-image-upload-default-src') ||
                record.preview['getAttribute']('src') || '';
            bound.set(field, record);
            subscribe('change', field, upload, record);
            subscribe('change', record.uri, updatePreview, record);
            subscribe('load', record.preview, previewFinished, record);
            subscribe('error', record.preview, previewFinished, record);
        },
        bind = function (field, form) {
            var fields,
                remaining;
            if (field && formDom['nodeType'].call(field) === 1 && formDom['tagName'].call(field) === 'FORM') {
                fields = formElements.call(field);
                remaining = fields.length;
                while (remaining--) {
                    if (fields[remaining]['type'] === 'file' && fields[remaining]['hasAttribute']('data-image-upload-action')) {
                        bindField(fields[remaining], field);
                    }
                }
            } else if (field && field['type'] === 'file') {
                bindField(field, form);
            }
        },
        forms = $doc['forms'],
        remaining = forms.length;

    imageupload['bind'] = bind;
    while (remaining--) {
        bind(forms[remaining]);
    }
});
