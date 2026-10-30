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
 * Opt-in anchor navigation into a named fragment target. The href remains the
 * full-page URL. Modified clicks, downloads, other contexts and local hashes
 * remain native. History traversal reloads the destination as an ordinary page.
 * data-paste-io-reply-fragment-timeout declares the request deadline in
 * decimal milliseconds, "0" for none.
 * @requires paste/event
 * @requires paste/ui/utilities/io-html-fragment
 * @module paste/ui/fragment_navigation
 */
paste['define']('paste.ui.fragment_navigation', ['paste.event', 'paste.ui.utilities.io-html-fragment'], function (navigation, event, fragment) {
    'use strict';

    var $w = window,
        $doc = document,
        $location = $w['location'],
        $history = $w['history'],
        URLCtor = $w['URL'],
        Subscription = event['Event']['Subscription'],
        elementPrototype = $w['Element'] && $w['Element']['prototype'],
        htmlPrototype = $w['HTMLElement'] && $w['HTMLElement']['prototype'],
        $closest = elementPrototype && elementPrototype['closest'],
        $getAttribute = elementPrototype && elementPrototype['getAttribute'],
        $hasAttribute = elementPrototype && elementPrototype['hasAttribute'],
        $setAttribute = elementPrototype && elementPrototype['setAttribute'],
        $scrollIntoView = elementPrototype && elementPrototype['scrollIntoView'],
        $focus = htmlPrototype && htmlPrototype['focus'],
        ATTRIBUTE = 'data-paste-io-reply-fragment',
        TARGET = 'data-paste-io-reply-fragment-target',
        // data-paste-io-reply-fragment-timeout follows
        // data-paste-form-timeout's contract: decimal milliseconds, "0" for
        // no deadline, otherwise the default.
        WHOLE_NUMBER = /^[0-9]+$/,
        DEFAULT_TIMEOUT = 30000,
        timeoutFor = function (element) {
            var declared = $getAttribute.call(element, 'data-paste-io-reply-fragment-timeout'),
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
        pending,

        unloadWatch,
        displayed = $location['href'].split('#')[0],
        release = function () {
            pending = null;
            if (unloadWatch) {
                unloadWatch['dispose']();
                unloadWatch = null;
            }
        },
        cancel = function () {
            if (pending) {
                pending['cancel']();
            }
            release();
        },
        onHistory = function () {
            // The server already supplies the complete page at every href.
            // Hash-only traversal retains the browser's normal fragment behavior.
            // A popstate that keeps the document address, such as an
            // enhancement settling its own fragment, leaves a pending request
            // standing; a hash-only navigation still cancels it on hashchange.
            if ($location['href'].split('#')[0] !== displayed) {
                cancel();
                $location['reload']();
            }
        },
        findTarget = function (name) {
            var targets = $doc['querySelectorAll']('[' + TARGET + ']'),
                count = targets.length,
                target = null;
            while (count--) {
                if ($getAttribute.call(targets[count], TARGET) === name) {
                    if (target) {
                        return null;
                    }
                    target = targets[count];
                }
            }
            return target;
        },
        onClick = function (e) {
            var anchor = e['target'],
                url,
                target,
                context,
                base,
                operation,
                handled = false,
                completed = false,
                historyCommitted = false,
                done,
                failed;
            if (e['defaultPrevented'] || e['button'] !== 0 || e['metaKey'] || e['ctrlKey'] || e['shiftKey'] || e['altKey']) {
                return;
            }
            anchor = anchor && anchor['nodeType'] === 1 ? $closest.call(anchor, 'a') : null;
            if (!anchor || !$hasAttribute.call(anchor, ATTRIBUTE) || !$hasAttribute.call(anchor, 'href') || $hasAttribute.call(anchor, 'download') ||
                    $hasAttribute.call(anchor, 'referrerpolicy') || $hasAttribute.call(anchor, 'ping') ||
                    /(^|\s)noreferrer(\s|$)/i.test($getAttribute.call(anchor, 'rel') || '')) {
                return;
            }
            context = $getAttribute.call(anchor, 'target');
            if (!context) {
                base = $doc['querySelector']('base[target]');
                context = base && $getAttribute.call(base, 'target');
            }
            if (context && context.toLowerCase() !== '_self') {
                return;
            }
            try {
                url = new URLCtor(anchor['href']);
            } catch (invalid) {
                return;
            }
            if (!/^https?:$/.test(url['protocol']) || url['origin'] !== $location['origin'] ||
                    url['username'] || url['password'] || url['href'].split('#')[0] === $location['href'].split('#')[0]) {
                return;
            }
            target = findTarget($getAttribute.call(anchor, ATTRIBUTE));
            if (!target) {
                return;
            }
            cancel();
            done = function (response) {
                var focusTarget = target,
                    data = response && typeof response === 'object' && response['data'];
                completed = true;
                release();
                if (data && typeof data['title'] === 'string') {
                    $doc['title'] = data['title'];
                }
                if (url['hash']) {
                    try {
                        focusTarget = $doc['getElementById'](decodeURIComponent(url['hash'].slice(1))) || target;
                    } catch (invalidHash) {
                        focusTarget = target;
                    }
                }
                if (!$hasAttribute.call(focusTarget, 'tabindex')) {
                    $setAttribute.call(focusTarget, 'tabindex', '-1');
                }
                if (htmlPrototype.isPrototypeOf(focusTarget)) {
                    $focus.call(focusTarget, {preventScroll: true});
                }
                $scrollIntoView.call(focusTarget);
            };
            failed = function (reason, sent) {
                completed = true;
                release();
                handled = reason === 'busy';
                if (sent && reason !== 'stale' && reason !== 'superseded') {
                    if (historyCommitted) {
                        $location['replace'](url['href']);
                    } else {
                        $location['assign'](url['href']);
                    }
                }
            };
            operation = fragment['load'](target, {
                url: url['href'],
                timeout: timeoutFor(anchor),
                acceptResponse: function (status, xhr) {
                    // XHR hides redirect fragments. Let native navigation preserve
                    // the complete redirect semantics instead of guessing the hash.
                    return status >= 200 && status < 300 && xhr['responseURL'] === url['href'].split('#')[0];
                },
                beforePlace: function () {
                    $history['pushState'](null, '', url['href']);
                    historyCommitted = true;
                    displayed = url['href'].split('#')[0];
                },
                onDone: done,
                onFailed: failed
            });
            if (operation || handled) {
                e['preventDefault']();
            }
            if (operation && !completed) {
                pending = operation;
                // A later native navigation supersedes this optional request,
                // including when the visitor subsequently dismisses its prompt.
                unloadWatch = new Subscription('beforeunload', $w, cancel);
            }
        };

    if ($closest && $focus && $scrollIntoView && URLCtor && $history && $history['pushState'] && $doc['querySelector']('a[' + ATTRIBUTE + ']')) {
        event['bind']('click', $doc, onClick);
        event['bind']('popstate', $w, onHistory);
        event['bind']('hashchange', $w, cancel);
    }
});
