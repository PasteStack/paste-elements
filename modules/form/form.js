/*jslint white:false plusplus:false browser:true nomen:false sub:true unparam:true */
/*globals paste */

/**
 * Submit a form[data-paste-form] inside an IO reply fragment target in the
 * background and replace the target's content with the returned markup. Forms
 * without an IO reply fragment target, or in browsers without the required
 * capabilities, submit normally.
 *
 * A request that fails without a usable answer may still have delivered the
 * submission, and a response the form cannot place — a non-HTML reply or an
 * HTML reply from another origin — is still a transmitted POST. So one replay
 * rule covers every failure after transmission: an automatic native resubmit
 * happens only for a GET or a form marked data-paste-form-idempotent. Every
 * failure first releases the busy state, then fires a bubbling, cancelable
 * "paste.ui.form:failed" event from the form — detail.reason is one of
 * "response", "error", "timeout" or "abort" — and a failure nobody handles
 * gets a default alert notice inside the form, preserving entered values.
 * Only a submit that never transmitted resubmits unconditionally.
 *
 * The background request carries a deadline (default 30s, per form via
 * data-paste-form-timeout in decimal milliseconds, "0" for none) so a
 * stalled request cannot hold the target busy forever.
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

        /*
         * Milliseconds a background submit waits for an answer before the
         * request is treated as failed — without one, a stalled request holds
         * aria-busy forever. data-paste-form-timeout overrides per form; only
         * decimal digits in the XHR range are honored — "0" asks for no
         * deadline, and blank, fractional, signed, scientific-notation,
         * hexadecimal or overflowing input falls back to the default rather
         * than silently disabling the deadline.
         */
        DEFAULT_TIMEOUT = 30000,

        timeoutFor = function ($form) {
            var declared = $form.getAttribute('data-paste-form-timeout'),
                timeout;
            if (declared === '0') {
                return 0;
            }
            if (declared === null || declared === '' || !/^[0-9]+$/.test(declared)) {
                return DEFAULT_TIMEOUT;
            }
            timeout = Number(declared);
            return timeout >= 1 && timeout <= 4294967295 ? timeout : DEFAULT_TIMEOUT;
        },

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
     * status replaces the target's content, and every other outcome takes
     * the gated failure path — the cancelable event, then a declared-safe
     * native replay or the default notice. Markup without data-paste-form,
     * repeat enhancement, and browsers without WeakMap are left alone.
     */
    enhance = function ($form) {
        var inFlight,
            bypass,
            onSubmit,
            failureNotice;

        if (!enhanced || !$form || !$form.hasAttribute || !$form.hasAttribute('data-paste-form') || enhanced.has($form)) {
            return;
        }

        inFlight = false;
        bypass = false;
        // The one notice this module may add to the form — kept across
        // submissions so a retry replaces it rather than stacking another.
        failureNotice = null;

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
                clearFailure,
                showFailure,
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

            /*
             * The default outcome for a failed POST the site did not handle:
             * an honest notice inside the form — the request may have
             * delivered before it failed, so "check before submitting again"
             * — focused for the announcement while every entered value and
             * server-rendered message stays untouched. A listener that cancels
             * the failure event suppresses this; the notice only ever replaces
             * itself.
             */
            clearFailure = function () {
                if (failureNotice && failureNotice.parentElement && failureNotice.parentElement.removeChild) {
                    failureNotice.parentElement.removeChild(failureNotice);
                }
                failureNotice = null;
            };

            showFailure = function () {
                clearFailure();
                failureNotice = document.createElement('p');
                failureNotice.className = 'paste-ui-form-failure';
                failureNotice.setAttribute('role', 'alert');
                failureNotice.setAttribute('tabindex', '-1');
                failureNotice.textContent = 'We could not confirm your submission. It may have been received. Please check before submitting again.';
                $form.appendChild(failureNotice);
                if (failureNotice.focus) {
                    failureNotice.focus();
                }
            };

            // The submission is accepted for transmission — the notice an
            // earlier failure left is superseded.
            clearFailure();

            resubmit = function () {
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
                // paste.io invokes this callback from readystatechange —
                // before the browser dispatches the terminal error, timeout
                // or abort event that carries the actual cause. A status-0
                // "reply" is not an answer; leave the request unsettled so
                // that terminal event names the failure.
                if (status === 0) {
                    return;
                }
                if (xhr && xhr.getResponseHeader) {
                    contentType = xhr.getResponseHeader('content-type') || '';
                    contentType = contentType.toLowerCase();
                }
                // An answer the form cannot place — a non-HTML reply or an
                // HTML reply from another origin — is still a transmitted
                // POST, so it takes the same replay rule as a transport
                // failure rather than an unconditional native resubmit.
                if (contentType.indexOf('text/html') !== 0 || !(xhr && fromPageOrigin(xhr.responseURL))) {
                    fail('response');
                    return;
                }
                settled = true;
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

            /*
             * One failure notification and one cleanup per request. The busy
             * state clears before the event is dispatched so a listener can
             * start another submission without meeting the in-flight guard;
             * nothing is cleaned up after the listener returns — it may own a
             * new request by then. Automatic replay of a transmitted request
             * happens only where it cannot double the effect: a GET, or a
             * form whose endpoint is declared replay-safe with
             * data-paste-form-idempotent. Any other failure gets the default
             * notice — an unhandled POST never ends silently.
             *
             * Reasons: "response" (a completed response could not be placed),
             * "error" (transport failure), "timeout" (deadline expired),
             * "abort" (request aborted).
             */
            fail = function (reason) {
                var event;
                if (settled) {
                    return;
                }
                settled = true;
                finish();
                if (window.CustomEvent && $form.dispatchEvent) {
                    event = new window.CustomEvent('paste.ui.form:failed', {
                        bubbles: true,
                        cancelable: true,
                        detail: {reason: reason}
                    });
                    $form.dispatchEvent(event);
                    if (event.defaultPrevented) {
                        return;
                    }
                }
                if (method === 'get' || $form.hasAttribute('data-paste-form-idempotent')) {
                    resubmit();
                    return;
                }
                showFailure();
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
            // cover both: the terminal events name transport failures, and
            // load fires after the final readystatechange — a completed
            // response there is classified by the normal response path, and
            // a status-0 load is the error the thrown callback never
            // delivered. The settled guard keeps it all single.
            if (request) {
                try {
                    // The returned request already sent, but the timeout
                    // setter is legal at any point for an asynchronous XHR;
                    // a client that refuses the assignment simply keeps no
                    // deadline rather than losing the failure hooks — the
                    // handlers install outside this try/catch either way.
                    request.timeout = timeoutFor($form);
                } catch (ignore) {}
                request.onload = function () {
                    if (settled) {
                        return;
                    }
                    if (request.status === 0) {
                        fail('error');
                        return;
                    }
                    respond(request.responseText, request.status, request);
                };
                request.onerror = function () { fail('error'); };
                request.ontimeout = function () { fail('timeout'); };
                request.onabort = function () { fail('abort'); };
            } else {
                // paste.io could not start the request at all — nothing was
                // transmitted, so a native submission replays nothing.
                settled = true;
                finish();
                resubmit();
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
