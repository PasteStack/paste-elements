/*jslint white:false plusplus:false browser:true nomen:false sub:true unparam:true */
/*globals paste */

/**
 * Submit a form[data-paste-form] inside an IO reply fragment target in the
 * background and replace the target's content with the returned markup. Forms
 * without an IO reply fragment target, or in browsers without the required
 * capabilities, submit normally.
 * @requires paste/io
 * @module paste/ui/form
 */
paste.define('paste.ui.form', ['paste.io'], function (form, io) {
    'use strict';

    var enhanced = window.WeakMap ? new window.WeakMap() : null,

        /*
         * FormData(form, submitter) includes the submitting button's entry at
         * its tree position; a browser that ignores the second argument
         * leaves a button out, and one that cannot build it at all throws.
         */
        formDataTakesSubmitter = (function () {
            var $probeForm,
                $probeButton;
            if (!window.FormData || !document.createElement) {
                return false;
            }
            $probeForm = document.createElement('form');
            $probeButton = document.createElement('button');
            $probeButton.name = 'probe';
            $probeForm.appendChild($probeButton);
            try {
                return new window.FormData($probeForm, $probeButton).has('probe');
            } catch (ignore) {
                return false;
            }
        }()),

        URLENCODED = 'application/x-www-form-urlencoded',
        MULTIPART = 'multipart/form-data',

        ioReplyFragmentTarget = function ($form) {
            var $node = $form.parentElement;
            while ($node) {
                if ($node.hasAttribute && $node.hasAttribute('data-paste-io-reply-fragment-target')) {
                    return $node;
                }
                $node = $node.parentElement;
            }
            return null;
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
            return $form.getAttribute(formAttribute);
        },

        /*
         * With no form target or submitter formtarget, the document's
         * <base target> names the browsing context.
         */
        baseTarget = function () {
            var $base = document.querySelector ? document.querySelector('base[target]') : null;
            return $base ? $base.getAttribute('target') : null;
        },

        resolveAction = function (action) {
            var url;
            try {
                url = (action === null || action === '')
                    ? new window.URL(window.location.href)
                    : new window.URL(action, document.baseURI || window.location.href);
            } catch (ignore) {
                return null;
            }
            // Only same-origin markup is ever placed in the page.
            return url.origin === window.location.origin ? url : null;
        },

        /*
         * The origin of the URL a response actually came from; an empty or
         * absent responseURL never matches.
         */
        fromPageOrigin = function (href) {
            try {
                return new window.URL(href).origin === window.location.origin;
            } catch (ignore) {
                return false;
            }
        },

        toParams = function (fields) {
            var params = new window.URLSearchParams();
            fields.forEach(function (value, name) {
                params.append(name, typeof value === 'string' ? value : value.name);
            });
            return params;
        },

        enhance;

    /*
     * Enhance a form[data-paste-form] so a submit inside an IO reply
     * fragment target is sent through paste.io; an HTML response of any
     * status replaces the target's content, anything else resubmits
     * natively. Markup without data-paste-form, repeat enhancement, and
     * browsers without WeakMap are left alone.
     */
    enhance = function ($form) {
        var inFlight,
            bypass,
            onSubmit;

        if (!enhanced || !$form || !$form.hasAttribute || !$form.hasAttribute('data-paste-form') || enhanced.has($form)) {
            return;
        }

        inFlight = false;
        bypass = false;

        onSubmit = function (domEvent) {
            var $ioReplyFragmentTarget,
                method,
                enctype,
                target,
                url,
                $submitter,
                settled,
                submitted,
                fields,
                request,
                finish,
                resubmit,
                respond,
                fail;

            if (domEvent.defaultPrevented) {
                return;
            }
            if (bypass) {
                bypass = false;
                return;
            }
            $ioReplyFragmentTarget = ioReplyFragmentTarget($form);
            if (!$ioReplyFragmentTarget) {
                return;
            }
            if (!(window.XMLHttpRequest
                    && Object.prototype.hasOwnProperty.call(window.XMLHttpRequest.prototype, 'responseURL')
                    && window.FormData && window.URLSearchParams && window.URL
                    && formDataTakesSubmitter)) {
                return;
            }
            $submitter = domEvent.submitter;
            if ($submitter === undefined) {
                // A browser without SubmitEvent.submitter leaves no way to
                // reproduce the button's name/value or form* overrides.
                return;
            }
            if ($submitter && $submitter.type === 'image') {
                // An image control sends name.x/name.y, which this path
                // cannot reproduce.
                return;
            }
            method = effective($submitter, $form, 'formmethod', 'method') || 'get';
            method = method.toLowerCase();
            if (method !== 'get' && method !== 'post') {
                return;
            }
            enctype = effective($submitter, $form, 'formenctype', 'enctype') || URLENCODED;
            enctype = enctype.toLowerCase();
            if (method === 'post' && enctype === 'text/plain') {
                return;
            }
            target = effective($submitter, $form, 'formtarget', 'target');
            if (target === null) {
                target = baseTarget();
            }
            if (target && target.toLowerCase() !== '_self') {
                return;
            }
            url = resolveAction(effective($submitter, $form, 'formaction', 'action'));
            if (!url) {
                return;
            }
            domEvent.preventDefault();
            if (inFlight) {
                return;
            }
            inFlight = true;
            $ioReplyFragmentTarget.setAttribute('aria-busy', 'true');
            settled = false;

            finish = function () {
                $ioReplyFragmentTarget.removeAttribute('aria-busy');
                inFlight = false;
            };

            resubmit = function () {
                finish();
                submitted = false;
                // A control named "submit" or "requestSubmit" shadows the
                // form's own method, so the prototype methods are called
                // explicitly.
                if (window.HTMLFormElement
                        && window.HTMLFormElement.prototype.requestSubmit) {
                    bypass = true;
                    try {
                        window.HTMLFormElement.prototype.requestSubmit.call($form, $submitter || undefined);
                        submitted = true;
                    } catch (ignore) {
                        submitted = false;
                    }
                    bypass = false;
                }
                if (!submitted && window.HTMLFormElement) {
                    window.HTMLFormElement.prototype.submit.call($form);
                }
            };

            respond = function (response, status, xhr) {
                var contentType = '',
                    $target;
                if (settled) {
                    return;
                }
                settled = true;
                if (xhr && xhr.getResponseHeader) {
                    contentType = xhr.getResponseHeader('content-type') || '';
                    contentType = contentType.toLowerCase();
                }
                if (contentType.indexOf('text/html') !== 0 || !(xhr && fromPageOrigin(xhr.responseURL))) {
                    resubmit();
                    return;
                }
                $ioReplyFragmentTarget.innerHTML = xhr.responseText;
                Array.prototype.forEach.call(
                    $ioReplyFragmentTarget.querySelectorAll('form[data-paste-form]'),
                    function ($inner) {
                        enhance($inner);
                    }
                );
                $target = $ioReplyFragmentTarget.querySelector('[role="alert"], [role="status"]');
                if ($target) {
                    if (!$target.hasAttribute('tabindex')) {
                        $target.setAttribute('tabindex', '-1');
                    }
                    if ($target.focus) {
                        $target.focus();
                    }
                }
                finish();
            };

            fail = function () {
                if (settled) {
                    return;
                }
                settled = true;
                resubmit();
            };

            fields = new window.FormData($form, $submitter);

            if (method === 'get') {
                // A native GET submit replaces the action's query; a
                // fragment never reaches the server, so the request URL
                // drops it.
                url.search = toParams(fields).toString();
                url.hash = '';
                request = io['get'](url.href, null, respond, respond);
            } else if (enctype === MULTIPART) {
                request = io['post'](url.href, fields, respond, respond);
            } else {
                request = io['post'](url.href, toParams(fields).toString(), respond, respond);
            }
            // paste.io releases up to 2.0.2 throw inside readystatechange
            // on a status-0 reply, a reply without a Content-Type, or an
            // unparseable JSON body, so their callbacks never run; newer
            // releases call onFailure instead. The request's own events
            // cover those replies: load fires after the final
            // readystatechange, so it acts only when paste.io's callbacks
            // did not. The settled guard keeps the native resubmit single.
            if (request) {
                request.onload = fail;
                request.onerror = fail;
                request.ontimeout = fail;
                request.onabort = fail;
            } else {
                fail();
            }
        };

        enhanced.set($form, true);
        $form.addEventListener('submit', onSubmit, false);
    };

    Array.prototype.forEach.call(
        document.querySelectorAll('form[data-paste-form]'),
        function ($form) {
            enhance($form);
        }
    );
});
