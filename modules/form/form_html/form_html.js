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

/*jslint browser:true plusplus:true sub:true unparam:true */
/*globals paste */

/**
 * Enhance declared forms with fragment submission. Native submission semantics,
 * encoding, replay permission, failure notices and validity belong to this owner.
 * The shared HTML-fragment operation owns receiving and placing the reply.
 * @requires paste/event
 * @requires paste/ui/form/form_validity
 * @requires paste/ui/utilities/form-dom
 * @requires paste/ui/utilities/io-html-fragment
 * @module paste/ui/form/form_html
 */
paste['define']('paste.ui.form.form_html', ['paste.event', 'paste.ui.form.form_validity', 'paste.ui.utilities.form-dom', 'paste.ui.utilities.io-html-fragment'], function (formhtml, event, form, formDom, fragment) {
    'use strict';

    var $w = window,
        $doc = document,
        $getAttribute = formDom['getAttribute'],
        $hasAttribute = formDom['hasAttribute'],
        $parentElement = formDom['parentElement'],
        $dispatchEvent = formDom['dispatchEvent'],
        FormDataCtor = $w['FormData'],
        URLCtor = $w['URL'],
        URLSearchParamsCtor = $w['URLSearchParams'],
        TextDecoderCtor = $w['TextDecoder'],
        CustomEventCtor = $w['CustomEvent'],
        prototype = $w['HTMLFormElement'] && $w['HTMLFormElement']['prototype'],
        Subscription = event['Event']['Subscription'],
        bound = $w['WeakMap'] && FormDataCtor && URLCtor && URLSearchParamsCtor ? new $w['WeakMap']() : null,
        takesSubmitter,
        SELECTOR = 'form.paste-ui-formhtml, form[data-paste-form]',
        URLENCODED = 'application/x-www-form-urlencoded',
        MULTIPART = 'multipart/form-data',
        BUSY = 'paste-ui-formhtml-busy',
        LABEL_SPACE = /[\t\n\f\r ]+/,
        LABEL_SPACE_OR_COMMA = /[\t\n\f\r ,]+/,
        UTF16 = /^utf-16(le|be)$/,
        LINE_BREAKS = /\r\n|\r|\n/g,
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
        timeoutFor = function (element) {
            var value = $getAttribute.call(element, 'data-paste-form-timeout');
            return value !== null && /^[0-9]+$/.test(value) && Number(value) <= 4294967295 ? Number(value) : 30000;
        },
        replyTarget = function (element) {
            var node = $parentElement.call(element);
            while (node) {
                if (node['hasAttribute']('data-paste-io-reply-fragment-target')) {
                    return node;
                }
                node = node['parentElement'];
            }
            return null;
        },
        submitEncoding = function (declared, separators) {
            var labels = declared === null ? [] : declared.split(separators),
                labelIndex = labels.length,
                encoding = null,
                charset;
            while (labelIndex--) {
                if (labels[labelIndex] !== '') {
                    if (!TextDecoderCtor) {
                        return '';
                    }
                    try {
                        encoding = new TextDecoderCtor(labels[labelIndex])['encoding'];
                    } catch (ignore) {
                        // An unrecognised label is skipped, as the browser
                        // skips it.
                    }
                }
            }
            if (encoding === null) {
                charset = $doc['characterSet'];
                encoding = typeof charset === 'string' ? charset.toLowerCase() : '';
            }
            return UTF16.test(encoding) ? 'utf-8' : encoding;
        },

        // Only a UTF-8 submit matches the background body. Engines
        // differ on whether a comma separates labels, so both readings
        // must name UTF-8.
        encodesUtf8 = function ($form) {
            var declared = $getAttribute.call($form, 'accept-charset');
            return submitEncoding(declared, LABEL_SPACE) === 'utf-8'
                && (declared === null || declared.indexOf(',') === -1
                    || submitEncoding(declared, LABEL_SPACE_OR_COMMA) === 'utf-8');
        },

        /*
         * The submitting button's form* attribute, when it carries one,
         * overrides the form's own attribute — the same resolution the
         * browser applies.
         */
        effective = function ($submitter, $form, submitterAttribute, formAttribute) {
            if ($submitter && $submitter.hasAttribute && $submitter.hasAttribute(submitterAttribute)) {
                return $submitter.getAttribute(submitterAttribute);
            }
            return $getAttribute.call($form, formAttribute);
        },

        /*
         * With no form target or submitter formtarget, the document's
         * <base target> names the browsing context.
         */
        baseTarget = function () {
            var $base = $doc['querySelector'] ? $doc['querySelector']('base[target]') : null;
            return $base ? $base.getAttribute('target') : null;
        },

        toParams = function (fields) {
            var params = new URLSearchParamsCtor(),
                entries = fields['entries'](),
                step = entries['next'](),
                value;
            while (!step['done']) {
                value = step['value'][1];
                params['append'](
                    step['value'][0].replace(LINE_BREAKS, '\r\n'),
                    (typeof value === 'string' ? value : value['name']).replace(LINE_BREAKS, '\r\n')
                );
                step = entries['next']();
            }
            return params;
        },

        init,
        enhance = function (element) {
            var bypass = false,
                notice,
                clearNotice = function () {
                    if (notice && notice['parentElement']) {
                        notice['parentElement']['removeChild'](notice);
                    }
                    notice = null;
                },
                showNotice = function () {
                    clearNotice();
                    notice = $doc['createElement']('p');
                    notice['className'] = 'paste-ui-formhtml-failure';
                    notice['setAttribute']('role', 'alert');
                    notice['setAttribute']('tabindex', '-1');
                    notice['textContent'] = 'We could not confirm your submission. It may have been received. Please check before submitting again.';
                    formDom['appendChild'].call(element, notice);
                    notice['focus']();
                },
                onSubmit = function (e) {
                    var target,
                        submitter = e['submitter'],
                        method,
                        enctype,
                        browsingTarget,
                        url,
                        operation,
                        starting = true,
                        nativeReplay = false,
                        blocked = false,
                        pending = true,
                        busy = false,
                        leaving = false,
                        stayTimer,
                        failureTimer,
                        unloadWatch,
                        finish,
                        resubmit,
                        failed,
                        done;
                    if (e['defaultPrevented'] || bypass || !takesSubmitter || submitter === undefined ||
                            (submitter && submitter['type'] === 'image')) {
                        return;
                    }
                    target = replyTarget(element);
                    if (!target) {
                        return;
                    }
                    method = (effective(submitter, element, 'formmethod', 'method') || 'get').toLowerCase();
                    enctype = (effective(submitter, element, 'formenctype', 'enctype') || URLENCODED).toLowerCase();
                    browsingTarget = effective(submitter, element, 'formtarget', 'target');
                    if (!browsingTarget) {
                        browsingTarget = baseTarget();
                    }
                    if ((method !== 'get' && method !== 'post') || (method === 'post' && enctype === 'text/plain') ||
                            (browsingTarget && browsingTarget.toLowerCase() !== '_self') ||
                            /(^|\s)noreferrer(\s|$)/i.test($getAttribute.call(element, 'rel') || '') || !encodesUtf8(element)) {
                        return;
                    }
                    try {
                        url = effective(submitter, element, 'formaction', 'action');
                        url = url ? new URLCtor(url, $doc['baseURI']) : new URLCtor($w['location']['href']);
                    } catch (invalid) {
                        return;
                    }
                    unloadWatch = [];
                    finish = function () {
                        var count = unloadWatch.length;
                        pending = false;
                        if (busy) {
                            target['classList'].remove(BUSY);
                            busy = false;
                        }
                        $w['clearTimeout'](stayTimer);
                        $w['clearTimeout'](failureTimer);
                        while (count--) {
                            unloadWatch[count]['dispose']();
                        }
                    };
                    resubmit = function () {
                        bypass = true;
                        try {
                            if (prototype['requestSubmit']) {
                                try {
                                    prototype['requestSubmit'].call(element, submitter || undefined);
                                } catch (detachedSubmitter) {
                                    prototype['submit'].call(element);
                                }
                            } else {
                                prototype['submit'].call(element);
                            }
                        } finally {
                            bypass = false;
                        }
                    };
                    failed = function (reason, sent) {
                        var failure,
                            replayable = method === 'get' || $hasAttribute.call(element, 'data-paste-form-idempotent'),
                            report = function () {
                                finish();
                                // Replaced content no longer owns a presentation or native replay.
                                if (reason === 'stale' || reason === 'superseded' || !$doc['contains'](element)) {
                                    return;
                                }
                                if (CustomEventCtor) {
                                    failure = new CustomEventCtor('paste.ui.formhtml:failed', {
                                        bubbles: true,
                                        cancelable: true,
                                        detail: {reason: reason}
                                    });
                                    $dispatchEvent.call(element, failure);
                                    if (failure['defaultPrevented']) {
                                        return;
                                    }
                                }
                                if (replayable && !(leaving && (reason === 'error' || reason === 'abort'))) {
                                    if (starting) {
                                        nativeReplay = true;
                                    } else {
                                        resubmit();
                                    }
                                } else {
                                    showNotice();
                                }
                            };
                        if (reason === 'busy') {
                            blocked = true;
                            pending = false;
                            return;
                        }
                        if (reason === 'stale' || reason === 'superseded') {
                            blocked = true;
                            finish();
                            return;
                        }
                        if (!sent) {
                            finish();
                            return;
                        }
                        if (busy) {
                            target['classList'].remove(BUSY);
                            busy = false;
                        }
                        report();
                    };
                    done = function () {
                        var announcement;
                        finish();
                        form['init'](target);
                        init(target);
                        announcement = target['querySelector']('[role="alert"], [role="status"]');
                        if (announcement) {
                            if (!announcement['hasAttribute']('tabindex')) {
                                announcement['setAttribute']('tabindex', '-1');
                            }
                            announcement['focus']();
                        }
                    };
                    clearNotice();
                    operation = fragment['load'](target, {
                        timeout: timeoutFor(element),
                        acceptResponse: function (status) { return status >= 200 && status <= 599; },
                        isCurrent: function () { return $doc['contains'](element) && replyTarget(element) === target; },
                        prepare: function () {
                            var fields = new FormDataCtor(element, submitter),
                                body = null;
                            if (method === 'get') {
                                url['search'] = toParams(fields)['toString']();
                                url['hash'] = '';
                            } else {
                                body = enctype === MULTIPART ? fields : toParams(fields)['toString']();
                            }
                            return {url: url['href'], method: method.toUpperCase(), body: body,
                                contentType: method === 'post' && enctype !== MULTIPART ? URLENCODED : null};
                        },
                        deferFailure: function (reason, complete) {
                            // A navigation can fail XHR before beforeunload. Keep
                            // the target reserved until this owned decision runs.
                            if (!starting && !leaving && (method === 'get' || $hasAttribute.call(element, 'data-paste-form-idempotent')) &&
                                    (reason === 'error' || reason === 'abort')) {
                                failureTimer = $w['setTimeout'](complete, 0);
                            } else {
                                complete();
                            }
                        },
                        onStart: function () { target['classList'].add(BUSY); busy = true; },
                        onDone: done,
                        onFailed: failed
                    });
                    starting = false;
                    if (blocked || (operation && !nativeReplay)) {
                        e['preventDefault']();
                    }
                    if (operation && pending) {
                        unloadWatch = [
                            new Subscription('beforeunload', $w, function () {
                                leaving = true;
                                $w['clearTimeout'](stayTimer);
                                stayTimer = $w['setTimeout'](function () {
                                    if (pending) {
                                        stayTimer = $w['setTimeout'](function () { leaving = false; }, 500);
                                    }
                                }, 0);
                            }),
                            new Subscription('pagehide', $w, function () {
                                leaving = true;
                                $w['clearTimeout'](stayTimer);
                            })
                        ];
                    }
                };
            if (bound.has(element)) {
                return;
            }
            // Native form registration is the narrow named-control shadowing exception.
            formDom['addEventListener'].call(element, 'submit', onSubmit, false);
            bound.set(element, true);
        };

    init = function (root) {
        var parent = root || $doc,
            forms,
            count;
        if (!bound) {
            return;
        }
        forms = parent['querySelectorAll'](SELECTOR);
        count = forms.length;
        if (takesSubmitter === undefined && count) {
            takesSubmitter = supportsSubmitter();
        }
        if (takesSubmitter) {
            while (count--) {
                enhance(forms[count]);
            }
        }
    };
    init();
});
