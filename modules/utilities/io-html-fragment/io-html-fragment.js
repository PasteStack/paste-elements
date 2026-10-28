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

/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Receive trusted same-origin HTML, directly or in a named fragment envelope.
 * Callers own the trigger, request data, success policy and initialization.
 * apply() also places an already received autosave reply without another I/O.
 * No automatic work, navigation, asset loading or form policy starts here.
 * @requires paste/io
 * @module paste/ui/utilities/io-html-fragment
 */
paste['define']('paste.ui.utilities.io-html-fragment', ['paste.io'], function (fragment, io) {
    'use strict';

    var $w = window,
        $doc = document,
        URLCtor = $w['URL'],
        XHRCtor = $w['XMLHttpRequest'],
        $location = $w['location'],
        // Capture only this operation's native DOM members. Form controls can
        // shadow instance members; no property dispatch or prototype walk runs.
        elementPrototype = $w['Element'] && $w['Element']['prototype'],
        nodePrototype = $w['Node'] && $w['Node']['prototype'],
        $getAttribute = elementPrototype && elementPrototype['getAttribute'],
        $hasAttribute = elementPrototype && elementPrototype['hasAttribute'],
        $setAttribute = elementPrototype && elementPrototype['setAttribute'],
        $removeAttribute = elementPrototype && elementPrototype['removeAttribute'],
        $querySelectorAll = elementPrototype && elementPrototype['querySelectorAll'],
        $contains = nodePrototype && nodePrototype['contains'],
        htmlDescriptor = elementPrototype && Object['getOwnPropertyDescriptor'](elementPrototype, 'innerHTML'),
        classDescriptor = elementPrototype && Object['getOwnPropertyDescriptor'](elementPrototype, 'classList'),
        $html = htmlDescriptor && htmlDescriptor.set,
        $classes = classDescriptor && classDescriptor.get,
        $keys = Object['keys'],
        $hasOwn = Object['prototype']['hasOwnProperty'],
        active = [],
        TARGET = 'data-paste-io-reply-fragment-target',
        BUSY = 'paste-ui-io-html-fragment-busy',
        overlaps = function (a, b) {
            return a === b || $contains.call(a, b) || $contains.call(b, a);
        },
        fromPage = function (href) {
            var url;
            try {
                url = new URLCtor(href, $doc['baseURI']);
                return (/^https?:$/).test(url['protocol']) && url['origin'] === $location['origin'];
            } catch (invalid) {
                return false;
            }
        },
        bindings = function (root, variables, attribute, scalars) {
            var targets = root === $doc ? $doc['querySelectorAll']('[' + attribute + ']') : $querySelectorAll.call(root, '[' + attribute + ']'),
                remaining = targets.length,
                target,
                index = 0,
                pairs,
                count,
                pairIndex,
                pair,
                separator,
                name,
                variable,
                type;
            // The root may itself carry a binding.
            while (remaining >= 0) {
                target = remaining === targets.length ? root : targets[index++];
                remaining -= 1;
                if (target !== $doc && $hasAttribute.call(target, attribute)) {
                    pairs = $getAttribute.call(target, attribute).split(',');
                    count = pairs.length;
                    pairIndex = 0;
                    while (count--) {
                        pair = pairs[pairIndex];
                        pairIndex += 1;
                        separator = pair.indexOf('=');
                        if (separator !== -1) {
                            name = pair.slice(0, separator).trim();
                            variable = pair.slice(separator + 1).trim();
                            type = typeof variables[variable];
                            if (name && $hasOwn.call(variables, variable) && (type === 'string' ||
                                    (scalars && (type === 'number' || type === 'boolean')))) {
                                try {
                                    $setAttribute.call(target, name, variables[variable]);
                                } catch (invalidAttribute) {
                                    if (invalidAttribute.name !== 'InvalidCharacterError') {
                                        throw invalidAttribute;
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        applyVariables = function (root, variables) {
            if (variables && typeof variables === 'object') {
                bindings(root, variables, 'data-update-attribute', true);
                bindings(root, variables, 'data-paste-io-reply-fragment-bind', false);
            }
        },
        write = function (target, markup, owner) {
            var count = active.length,
                retired = [],
                operation;
            // A committed independent reply supersedes an older pending writer.
            // Retire before touching the DOM; its late reply cannot write back.
            while (count--) {
                operation = active[count];
                if (operation !== owner && overlaps(target, operation.target)) {
                    retired.push(operation.cancel('superseded', true));
                }
            }
            try {
                $html.call(target, markup);
            } finally {
                count = retired.length;
                while (count--) {
                    retired[count]();
                }
            }
        },
        applyMarkup = function (modules, attribute) {
            var names,
                remaining,
                index = 0,
                name,
                entry,
                targets,
                count,
                targetIndex,
                target;
            if (!modules || typeof modules !== 'object') {
                return;
            }
            names = $keys(modules);
            remaining = names.length;
            while (remaining--) {
                name = names[index];
                index += 1;
                entry = modules[name];
                if (entry && typeof entry['markup'] === 'string') {
                    // Earlier markup can introduce targets for the next name.
                    targets = $doc['querySelectorAll']('[' + attribute + ']');
                    count = targets.length;
                    targetIndex = 0;
                    while (count--) {
                        target = targets[targetIndex];
                        targetIndex += 1;
                        if ($getAttribute.call(target, attribute) === name && $contains.call($doc, target)) {
                            write(target, entry['markup']);
                        }
                    }
                }
            }
        },
        apply = function (data) {
            applyMarkup(data['modules'], 'data-update-contents');
            applyMarkup(data['fragments'], TARGET);
            applyVariables($doc, data['variables']);
        },
        load = function (target, options) {
            var count = active.length,
                request,
                operation,
                sent = false,
                settled = false,
                finished = false,
                busy = false,
                previousBusy,
                hadClass,
                prepared,
                format = $getAttribute && $getAttribute.call(target, 'data-paste-io-reply-fragment-format'),
                release,
                fail,
                cancel,
                receive;
            if (!$html || !$classes || !URLCtor || !XHRCtor || !$hasOwn.call(XHRCtor['prototype'], 'responseURL') || !$contains.call($doc, target) || (format !== null && format !== 'html' && format !== 'json')) {
                options['onFailed']('unsupported', false);
                return null;
            }
            while (count--) {
                if (overlaps(target, active[count].target)) {
                    options['onFailed']('busy', false);
                    return null;
                }
            }
            release = function () {
                var index = active.indexOf(operation);
                if (index !== -1) {
                    active.splice(index, 1);
                }
                if (busy) {
                    if (previousBusy === null) {
                        $removeAttribute.call(target, 'aria-busy');
                    } else {
                        $setAttribute.call(target, 'aria-busy', previousBusy);
                    }
                    if (!hadClass) {
                        $classes.call(target).remove(BUSY);
                    }
                    busy = false;
                }
            };
            fail = function (reason) {
                var complete;
                if (!settled) {
                    settled = true;
                    complete = function () {
                        if (!finished) {
                            finished = true;
                            release();
                            options['onFailed'](reason, sent);
                        }
                    };
                    // A caller may defer its failure decision while retaining
                    // the destination. A newer committed write can still retire it.
                    if (options['deferFailure']) {
                        options['deferFailure'](reason, complete);
                    } else {
                        complete();
                    }
                }
            };
            cancel = function (reason, defer) {
                if (!finished) {
                    settled = true;
                    finished = true;
                    release();
                    if (request) {
                        try {
                            request['abort']();
                        } catch (ignore) {
                            // Applicability and cleanup already ended; the reply is ignored.
                        }
                    }
                    if (reason) {
                        if (defer) {
                            return function () { options['onFailed'](reason, sent); };
                        }
                        options['onFailed'](reason, sent);
                    }
                }
            };
            receive = function (response, status, xhr) {
                var type,
                    accepted,
                    data,
                    fragments,
                    name,
                    entry,
                    markup,
                    placed = false;
                if (settled || status === 0) {
                    return;
                }
                if (!$contains.call($doc, target) || (options['isCurrent'] && !options['isCurrent']())) {
                    fail('stale');
                    return;
                }
                accepted = options['acceptResponse'] ? options['acceptResponse'](status, xhr) : status >= 200 && status < 300;
                if (!accepted || status === 204 || status === 205 || status === 304) {
                    fail('response');
                    return;
                }
                type = (xhr['getResponseHeader']('Content-Type') || '').toLowerCase();
                if (!xhr['responseURL'] || !fromPage(xhr['responseURL'])) {
                    fail('response');
                    return;
                }
                try {
                    if (/^text\/html(?:[ \t]*;|[ \t]*$)/.test(type)) {
                        response = xhr['responseText'];
                        markup = response;
                    } else if (/^application\/json(?:[ \t]*;|[ \t]*$)/.test(type)) {
                        response = typeof response === 'object' ? response : JSON['parse'](xhr['responseText']);
                        data = response && response['data'];
                        fragments = data && data['fragments'];
                        name = $getAttribute.call(target, TARGET);
                        entry = name !== null && fragments && $hasOwn.call(fragments, name) && fragments[name];
                        markup = entry ? entry['markup'] : null;
                    } else {
                        fail('response');
                        return;
                    }
                    if (typeof markup === 'string') {
                        // Navigation must commit its URL before native resources
                        // in the new markup resolve relative addresses.
                        if (options['beforePlace']) {
                            options['beforePlace']();
                            if (settled) {
                                return;
                            }
                            if (!$contains.call($doc, target) || (options['isCurrent'] && !options['isCurrent']())) {
                                fail('stale');
                                return;
                            }
                        }
                        write(target, markup, operation);
                        if (data) {
                            applyVariables(target, data['variables']);
                        }
                        placed = true;
                    }
                } catch (refused) {
                    placed = false;
                }
                if (!placed) {
                    fail('response');
                    return;
                }
                if (finished) {
                    return;
                }
                settled = true;
                finished = true;
                release();
                options['onDone'](response, status, xhr);
            };
            operation = {target: target, cancel: cancel};
            active.push(operation);
            try {
                // Reserve before FormData can dispatch a reentrant formdata event.
                prepared = options['prepare'] ? options['prepare']() : options;
                if (settled) {
                    return null;
                }
                if (!$contains.call($doc, target) || (options['isCurrent'] && !options['isCurrent']())) {
                    fail('stale');
                    return null;
                }
                if (!fromPage(prepared['url'])) {
                    fail('unsupported');
                    return null;
                }
                request = io['open'](prepared['method'] || 'GET', prepared['url'], receive, receive);
                if (!request || request['responseURL'] === undefined) {
                    fail('unsupported');
                    return null;
                }
                request['setRequestHeader']('Accept', format === 'json' ? 'application/json' : 'text/html, application/json');
                if (prepared['contentType']) {
                    request['setRequestHeader']('Content-Type', prepared['contentType']);
                }
                request['timeout'] = options['timeout'] === undefined ? 30000 : options['timeout'];
                // XHR is an owned operation, not a DOM subscription target.
                request['onerror'] = function () { fail('error'); };
                request['ontimeout'] = function () { fail('timeout'); };
                request['onabort'] = function () { fail('abort'); };
                previousBusy = $getAttribute.call(target, 'aria-busy');
                hadClass = $classes.call(target).contains(BUSY);
                $setAttribute.call(target, 'aria-busy', 'true');
                $classes.call(target).add(BUSY);
                busy = true;
                if (options['onStart']) {
                    options['onStart']();
                }
                if (settled) {
                    return null;
                }
                sent = true;
                request['send'](prepared['body'] === undefined ? null : prepared['body']);
            } catch (refused) {
                if (!settled) {
                    sent = false;
                    fail('request');
                }
                return null;
            }
            return {cancel: cancel};
        };

    fragment['load'] = load;
    fragment['apply'] = apply;
});
