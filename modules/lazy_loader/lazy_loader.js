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

/*jslint browser:true plusplus:true sub:true nomen:true */
/*globals paste */

/**
 * Deferred HTML loading. The caller decides when to request
 * all or laid-out descendants and how to initialize the inserted content.
 * No automatic scan, viewport listener or asset loader is installed.
 * data-lazy-load-timeout declares the request deadline in decimal
 * milliseconds, "0" for none.
 * @requires paste/ui/utilities/io-html-fragment
 * @module paste/ui/lazy_loader
 */
paste['define']('paste.ui.lazy_loader', ['paste.ui.utilities.io-html-fragment'], function (module, fragment) {
    'use strict';

    var ATTRIBUTE = 'data-lazy-load',
        $doc = document,
        prototype = window['Element'] && window['Element']['prototype'],
        htmlPrototype = window['HTMLElement'] && window['HTMLElement']['prototype'],
        widthDescriptor = htmlPrototype && Object['getOwnPropertyDescriptor'](htmlPrototype, 'offsetWidth'),
        heightDescriptor = htmlPrototype && Object['getOwnPropertyDescriptor'](htmlPrototype, 'offsetHeight'),
        $width = widthDescriptor && widthDescriptor.get,
        $height = heightDescriptor && heightDescriptor.get,
        $getAttribute = prototype && prototype['getAttribute'],
        $removeAttribute = prototype && prototype['removeAttribute'],
        $querySelectorAll = prototype && prototype['querySelectorAll'],
        WeakMapCtor = window['WeakMap'],
        pending = WeakMapCtor && $getAttribute ? new WeakMapCtor() : null,
        // data-lazy-load-timeout follows data-paste-form-timeout's contract:
        // decimal milliseconds, "0" for no deadline, otherwise the default.
        WHOLE_NUMBER = /^[0-9]+$/,
        DEFAULT_TIMEOUT = 30000,
        timeoutFor = function (element) {
            var declared = $getAttribute.call(element, 'data-lazy-load-timeout'),
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
        init_new_content = null,
        load_lazy_content = function (element) {
            var url,
                loaded,
                failed;
            if (!pending || pending.has(element)) {
                return;
            }
            url = $getAttribute.call(element, ATTRIBUTE);
            if (!url) {
                return;
            }
            loaded = function () {
                pending.delete(element);
                $removeAttribute.call(element, ATTRIBUTE);
                if (init_new_content) {
                    init_new_content.call(element, element);
                }
            };
            failed = function () { pending.delete(element); };
            pending.set(element, true);
            fragment['load'](element, {
                url: url,
                timeout: timeoutFor(element),
                isCurrent: function () { return $getAttribute.call(element, ATTRIBUTE) === url; },
                onDone: loaded,
                onFailed: failed
            });
        },
        load_all_content = function (parent) {
            var elements,
                count,
                index = 0;
            if (!pending) {
                return;
            }
            elements = parent === $doc ? $doc['querySelectorAll']('[' + ATTRIBUTE + ']') : $querySelectorAll.call(parent, '[' + ATTRIBUTE + ']');
            count = elements.length;
            while (count--) {
                load_lazy_content(elements[index]);
                index += 1;
            }
        },
        load_visible_content = function (parent) {
            var elements,
                count,
                index = 0,
                element;
            if (!pending) {
                return;
            }
            elements = parent === $doc ? $doc['querySelectorAll']('[' + ATTRIBUTE + ']') : $querySelectorAll.call(parent, '[' + ATTRIBUTE + ']');
            count = elements.length;
            while (count--) {
                element = elements[index];
                index += 1;
                if (!pending.has(element) && $width && $height && htmlPrototype.isPrototypeOf(element) &&
                        $width.call(element) > 0 && $height.call(element) > 0) {
                    load_lazy_content(element);
                }
            }
        },
        set_init_new_content = function (callback) {
            init_new_content = typeof callback === 'function' ? callback : null;
        };

    module['set_init_new_content'] = set_init_new_content;
    module['load_all_content'] = load_all_content;
    module['load_visible_content'] = load_visible_content;
    module['load_lazy_content'] = load_lazy_content;
});
