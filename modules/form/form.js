/*jslint browser:true plusplus:true sub:true unparam:true */
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
 * stalled request cannot hold the target busy forever. The deadline runs
 * on the module's own timer and aborts the request, reported as
 * "timeout": the client sends before it returns the request, and an
 * engine may ignore an XHR timeout assigned after send.
 *
 * Leaving the page mid-submit is the visitor's choice: an engine may
 * abort the in-flight request as the navigation starts, or fail it as a
 * network error, and a replay then would take the visitor to the form's
 * answer instead of where they went. An abort or error that follows
 * beforeunload or pagehide is never replayed; it still fires the event,
 * and an unhandled one gets the default notice in place of the replay —
 * harmless on a page being left, and the honest outcome when the
 * navigation ends without leaving (a download or a 204). A beforeunload
 * the visitor answers by staying on the page counts for half a second
 * after the page's tasks resume (timers wait out the prompt), long enough
 * for an engine's own abort to arrive; without a pagehide by then the
 * page stayed, and a later failure keeps its replay rule. The deadline's
 * own abort is always a "timeout" and keeps its replay.
 *
 * The form data is built and the request started before the submit is
 * taken over: when FormData or paste.io throws, or paste.io starts no
 * request, nothing was transmitted, so the submit is left to proceed
 * natively and the target never turns busy. A failure the client reports
 * synchronously, while the submit is still being dispatched, never
 * resubmits from inside that dispatch: where replay is allowed, the
 * browser's own submit simply proceeds.
 *
 * An IO reply fragment target answers one submission at a time. While
 * a request is pending its target is aria-busy and owned by it, and a
 * submit from any form inside that target — or inside a target around or
 * within it, whose reply would replace it or be replaced by it — is
 * ignored until the request settles, so the answer that lands is always
 * the owner's.
 *
 * Encoding: urlencoded bodies and GET query strings are built with
 * URLSearchParams, and multipart bodies pass the FormData through for the
 * client to encode, so every body is UTF-8. A native submit picks the
 * first label in accept-charset the browser recognises, else the
 * document's encoding, and sends UTF-16 as UTF-8; a form whose submit
 * would go out in anything but UTF-8 submits natively. Engines differ on
 * whether a comma separates labels, so both readings must name UTF-8,
 * and on a label of the replacement encoding (iso-2022-kr and its
 * aliases) followed by another; TextDecoder refuses such a label, so it
 * is skipped and the later label decides. Line breaks in entry names and
 * string values are normalized to CRLF, as a native submit does; a file
 * entry contributes its file name.
 * @requires paste/io
 * @requires paste/event
 * @module paste/ui/form
 */
paste['define']('paste.ui.form', ['paste.io', 'paste.event'], function (form, io, event) {
    'use strict';

    // Host constructors are captured once, at define time.
    var $w = window,
        $doc = document,
        WeakMapCtor = $w['WeakMap'],
        FormDataCtor = $w['FormData'],
        URLCtor = $w['URL'],
        URLSearchParamsCtor = $w['URLSearchParams'],
        TextDecoderCtor = $w['TextDecoder'],
        $XMLHttpRequest = $w['XMLHttpRequest'],
        CustomEventCtor = $w['CustomEvent'],
        $HTMLFormElement = $w['HTMLFormElement'],
        $location = $w['location'],
        $setTimeout = $w['setTimeout'],
        $clearTimeout = $w['clearTimeout'],
        enhanced = WeakMapCtor ? new WeakMapCtor() : null,
        // Each IO reply fragment target with a pending request, mapped to
        // the submit that owns it.
        owners = WeakMapCtor ? new WeakMapCtor() : null,
        $hasOwn = Object['prototype']['hasOwnProperty'],
        // Every capability the background path needs; without one the
        // submit stays native.
        capable,
        Subscription = event['Event']['Subscription'],

        /*
         * FormData(form, submitter) includes the submitting button's entry at
         * its tree position; a browser that ignores the second argument
         * leaves a button out, and one that cannot build it at all throws.
         */
        formDataTakesSubmitter = (function () {
            var $probeForm,
                $probeButton;
            if (!FormDataCtor || !$doc['createElement']) {
                return false;
            }
            $probeForm = $doc['createElement']('form');
            $probeButton = $doc['createElement']('button');
            $probeButton['name'] = 'probe';
            $probeForm['appendChild']($probeButton);
            try {
                return new FormDataCtor($probeForm, $probeButton)['has']('probe');
            } catch (ex) {
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
        // The longest delay a host timer holds; a longer one fires at
        // once, so a deadline beyond it runs at this limit (about 24.8
        // days).
        TIMER_LIMIT = 2147483647,
        // How long a beforeunload still counts as leaving once the page's
        // tasks run again: the navigation's own abort or error arrives
        // well inside it.
        STAY_GRACE = 500,
        WHOLE_NUMBER = /^[0-9]+$/,
        // accept-charset label separators: ASCII whitespace, and the
        // comma some engines also split on.
        LABEL_SPACE = /[\t\n\f\r ]+/,
        LABEL_SPACE_OR_COMMA = /[\t\n\f\r ,]+/,
        // The encodings a form submits as UTF-8.
        UTF16 = /^utf-16(le|be)$/,
        // Every line break form: CRLF first so it is not read as two.
        LINE_BREAKS = /\r\n|\r|\n/g,

        timeoutFor = function ($form) {
            var declared = $form.getAttribute('data-paste-form-timeout'),
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
         * A target is taken while its own request is pending, or one
         * around it or inside it: either reply would replace the other's
         * markup.
         */
        taken = function ($target) {
            var $node = $target,
                inner = $target.querySelectorAll('[data-paste-io-reply-fragment-target]'),
                innerIndex = inner.length;
            while ($node) {
                if (owners.has($node)) {
                    return true;
                }
                $node = $node.parentElement;
            }
            while (innerIndex--) {
                if (owners.has(inner[innerIndex])) {
                    return true;
                }
            }
            return false;
        },

        /*
         * The encoding a native submit uses: the first accept-charset
         * label the browser recognises, else the document's, then the
         * output step that sends UTF-16 as UTF-8. The labels are walked
         * from the end so the first recognised one is kept; without
         * TextDecoder a declared label cannot be resolved, and no
         * encoding is named.
         */
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
            var declared = $form.getAttribute('accept-charset');
            return submitEncoding(declared, LABEL_SPACE) === 'utf-8'
                && submitEncoding(declared, LABEL_SPACE_OR_COMMA) === 'utf-8';
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
            var $base = $doc['querySelector'] ? $doc['querySelector']('base[target]') : null;
            return $base ? $base.getAttribute('target') : null;
        },

        // The captured timers, refusals contained: a refused start keeps
        // no deadline, and a refused clear leaves a deadline that finds
        // its request settled when it fires.
        startTimer = function (callback, delay) {
            if (typeof $setTimeout !== 'function') {
                return null;
            }
            try {
                return $setTimeout(callback, delay > TIMER_LIMIT ? TIMER_LIMIT : delay);
            } catch (refused) {
                return null;
            }
        },

        stopTimer = function (id) {
            if (id === null || typeof $clearTimeout !== 'function') {
                return;
            }
            try {
                $clearTimeout(id);
            } catch (ignore) {
                // The deadline checks the settled flag when it fires.
            }
        },

        resolveAction = function (action) {
            var url;
            try {
                url = (action === null || action === '')
                    ? new URLCtor($location['href'])
                    : new URLCtor(action, $doc['baseURI'] || $location['href']);
            } catch (ex) {
                return null;
            }
            // Only same-origin markup is ever placed in the page.
            return url['origin'] === $location['origin'] ? url : null;
        },

        /*
         * The origin of the URL a response actually came from; an empty or
         * absent responseURL never matches.
         */
        fromPageOrigin = function (href) {
            try {
                return new URLCtor(href)['origin'] === $location['origin'];
            } catch (ex) {
                return false;
            }
        },

        // FormData's own entry iterator, walked in document order — a
        // File entry contributes its name, as a urlencoded submit does.
        // Names and string values carry CRLF line breaks, as the native
        // name-value conversion writes them; FormData keeps a textarea's
        // bare LF.
        toParams = function (fields) {
            var params = new URLSearchParamsCtor(),
                entries = fields['entries'](),
                step = entries['next'](),
                value;
            while (!step['done']) {
                value = step['value'][1];
                params['append'](
                    step['value'][0].replace(LINE_BREAKS, '\r\n'),
                    typeof value === 'string' ? value.replace(LINE_BREAKS, '\r\n') : value['name']
                );
                step = entries['next']();
            }
            return params;
        },

        enhance,

        declaredForms = $doc['querySelectorAll']('form[data-paste-form]'),
        declaredIndex;

    /*
     * Enhance a form[data-paste-form] so a submit inside an IO reply
     * fragment target is sent through paste.io; an HTML response of any
     * status replaces the target's content, and every other outcome takes
     * the gated failure path — the cancelable event, then a declared-safe
     * native replay or the default notice. Markup without data-paste-form,
     * repeat enhancement, and browsers without WeakMap are left alone.
     */
    enhance = function ($form) {
        var bypass,
            onSubmit,
            failureNotice;

        if (!enhanced || !$form || !$form.hasAttribute || !$form.hasAttribute('data-paste-form') || enhanced.has($form)) {
            return;
        }

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
                // True while the client is being started inside this
                // submit's dispatch.
                starting,
                // A replay a synchronous failure asked for, left to the
                // native submit.
                replayNative,
                submitted,
                fields,
                request,
                timeout,
                // The pending deadline's timer, and whether it expired.
                deadline,
                expired,
                // True once the page began unloading while this request
                // was pending; the subscriptions that watch for it, and
                // the timer that ends a beforeunload the visitor stayed
                // through.
                leaving,
                unloadWatch,
                stayCheck,
                stayed,
                watchIndex,
                finish,
                expire,
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
            if (!capable) {
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
            if (!encodesUtf8($form)) {
                return;
            }
            if (taken($ioReplyFragmentTarget)) {
                domEvent.preventDefault();
                return;
            }
            settled = false;
            starting = false;
            replayNative = false;
            deadline = null;
            expired = false;
            leaving = false;
            unloadWatch = [];
            stayCheck = null;

            // Every settle path comes through here: the deadline, the
            // unload watch and the target's ownership end with the
            // request they belong to.
            finish = function () {
                if (owners.get($ioReplyFragmentTarget) === finish) {
                    owners['delete']($ioReplyFragmentTarget);
                    $ioReplyFragmentTarget.removeAttribute('aria-busy');
                }
                stopTimer(deadline);
                deadline = null;
                stopTimer(stayCheck);
                stayCheck = null;
                watchIndex = unloadWatch.length;
                while (watchIndex--) {
                    unloadWatch[watchIndex]['dispose']();
                }
                unloadWatch = [];
            };

            // The abort is reported through the request's own abort
            // event, which names it a timeout; a client that dispatches
            // none is settled by the direct call.
            expire = function () {
                deadline = null;
                if (settled) {
                    return;
                }
                expired = true;
                try {
                    request.abort();
                } catch (ignore) {
                    // The direct call below still settles it.
                }
                fail('timeout');
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
                failureNotice = $doc['createElement']('p');
                failureNotice.className = 'paste-ui-form-failure';
                failureNotice.setAttribute('role', 'alert');
                failureNotice.setAttribute('tabindex', '-1');
                failureNotice.textContent = 'We could not confirm your submission. It may have been received. Please check before submitting again.';
                $form.appendChild(failureNotice);
                if (failureNotice.focus) {
                    failureNotice.focus();
                }
            };

            resubmit = function () {
                submitted = false;
                // A control named "submit" or "requestSubmit" shadows the
                // form's own method, so the prototype methods are called
                // explicitly.
                if ($HTMLFormElement
                        && $HTMLFormElement['prototype']['requestSubmit']) {
                    bypass = true;
                    try {
                        $HTMLFormElement['prototype']['requestSubmit']['call']($form, $submitter || undefined);
                        submitted = true;
                    } catch (ex) {
                        submitted = false;
                    }
                    bypass = false;
                }
                if (!submitted && $HTMLFormElement) {
                    $HTMLFormElement['prototype']['submit']['call']($form);
                }
            };

            respond = function (response, status, xhr) {
                var contentType = '',
                    $target,
                    innerForms,
                    innerIndex;
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
                // Each replacement form binds its own submit
                // subscription — per-element work with no ordering, so
                // the sweep counts down.
                innerForms = $ioReplyFragmentTarget.querySelectorAll('form[data-paste-form]');
                innerIndex = innerForms.length;
                while (innerIndex--) {
                    enhance(innerForms[innerIndex]);
                }
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
             * data-paste-form-idempotent — and never for an abort or error
             * once the page began unloading, where the replay would replace
             * the visitor's own navigation. Any other failure gets the
             * default notice — an unhandled POST never ends silently.
             *
             * Reasons: "response" (a completed response could not be placed),
             * "error" (transport failure), "timeout" (deadline expired),
             * "abort" (request aborted).
             */
            fail = function (reason) {
                var failedEvent;
                if (settled) {
                    return;
                }
                settled = true;
                finish();
                if (CustomEventCtor && $form.dispatchEvent) {
                    failedEvent = new CustomEventCtor('paste.ui.form:failed', {
                        bubbles: true,
                        cancelable: true,
                        detail: {reason: reason}
                    });
                    $form.dispatchEvent(failedEvent);
                    if (failedEvent.defaultPrevented) {
                        return;
                    }
                }
                if ((method === 'get' || $form.hasAttribute('data-paste-form-idempotent'))
                        && !((reason === 'abort' || reason === 'error') && leaving)) {
                    // Inside the submit dispatch a resubmit is ignored and
                    // the dispatch's own submit is still pending: let it
                    // proceed instead.
                    if (starting) {
                        replayNative = true;
                        return;
                    }
                    resubmit();
                    return;
                }
                showFailure();
            };

            // A notice an earlier failure left is superseded by this
            // attempt; clearing it first keeps a failure the request
            // reports synchronously from being swept away.
            clearFailure();

            // Built and started before the submit is taken over: a throw
            // here means nothing was transmitted, so the browser's own
            // submit proceeds and no busy state was ever committed.
            starting = true;
            try {
                fields = new FormDataCtor($form, $submitter);
                if (method === 'get') {
                    // A native GET submit replaces the action's query; a
                    // fragment never reaches the server, so the request
                    // URL drops it.
                    url['search'] = toParams(fields)['toString']();
                    url['hash'] = '';
                    request = io['get'](url['href'], null, respond, respond);
                } else if (enctype === MULTIPART) {
                    request = io['post'](url['href'], fields, respond, respond);
                } else {
                    request = io['post'](url['href'], toParams(fields)['toString'](), respond, respond);
                }
            } catch (refused) {
                request = null;
            }
            starting = false;
            if (!request || replayNative) {
                // paste.io could not start the request — nothing was
                // transmitted, so the native submit replays nothing — or
                // it failed synchronously where replay is allowed, and
                // the native submit is that replay.
                return;
            }
            domEvent.preventDefault();
            // A client that answered synchronously has already settled
            // and released; busy, the deadline and the unload watch are
            // committed only for a pending request.
            if (!settled) {
                owners.set($ioReplyFragmentTarget, finish);
                $ioReplyFragmentTarget.setAttribute('aria-busy', 'true');
                timeout = timeoutFor($form);
                if (timeout) {
                    deadline = startTimer(expire, timeout);
                }
                // Window subscriptions held only while the request is
                // pending, so a settled form leaves no unload listener
                // behind. A beforeunload prompt holds the page's timers
                // until the visitor answers it, so the first timer runs
                // once they have; the grace after it lets a navigation's
                // own abort land first. A pagehide is final.
                stayed = function () {
                    stayCheck = null;
                    if (!settled) {
                        leaving = false;
                    }
                };
                unloadWatch = [
                    new Subscription('beforeunload', $w, function () {
                        leaving = true;
                        stopTimer(stayCheck);
                        stayCheck = startTimer(function () {
                            stayCheck = settled ? null : startTimer(stayed, STAY_GRACE);
                        }, 0);
                    }),
                    new Subscription('pagehide', $w, function () {
                        leaving = true;
                        stopTimer(stayCheck);
                        stayCheck = null;
                    })
                ];
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
            // Property handlers, not Subscriptions: an XHR is neither a
            // Node nor a window, and core rebinds such a target to the
            // document, where the request's events never arrive. The
            // request is owned by this submit and dropped with it.
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
            request.onabort = function () { fail(expired ? 'timeout' : 'abort'); };
        };

        // The submit listener goes through Paste's subscription contract —
        // the same ownership and teardown discipline every other module's
        // listeners carry — and stays referenced by the WeakMap entry.
        enhanced.set($form, new Subscription('submit', $form, onSubmit));
    };

    capable = !!($XMLHttpRequest
        && $hasOwn['call']($XMLHttpRequest['prototype'], 'responseURL')
        && FormDataCtor && URLSearchParamsCtor && URLCtor
        && formDataTakesSubmitter);

    declaredIndex = declaredForms.length;
    while (declaredIndex--) {
        enhance(declaredForms[declaredIndex]);
    }
});
