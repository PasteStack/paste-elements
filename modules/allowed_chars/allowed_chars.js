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
 * Filters typed characters using data-allowed-char-expr and/or
 * data-disallowed-char-expr. This is the original keypress enhancement: paste,
 * composition and programmatic changes remain native. Use pattern and
 * server validation when the complete value needs validation.
 * @requires paste/event
 * @module paste/ui/allowed_chars
 */
paste['define']('paste.ui.allowed_chars', ['paste.event'], function (allowedChars, event) {
    'use strict';

    var subscriptions = [],
        initialized = false,
        bind = event['bind'],
        fromCharCode = String['fromCharCode'],
        expression = function (source) {
            if (source) {
                try {
                    return new RegExp(source);
                } catch (invalidExpression) {
                    // A malformed authored expression leaves editing native.
                    return null;
                }
            }
            return null;
        },
        onKeypress = function (e) {
            var code = e['charCode'] === undefined ? e['which'] : e['charCode'],
                character;
            if (e['ctrlKey'] || e['metaKey'] || e['altKey'] || e['isComposing'] || !code ||
                    (e['key'] && e['key'].length > 1)) {
                return;
            }
            character = fromCharCode(code);
            if ((this.allowed && !this.allowed.test(character)) ||
                    (this.disallowed && this.disallowed.test(character))) {
                e['preventDefault']();
            }
        },
        initialize = function (force) {
            var elements,
                remaining,
                element,
                rules;
            if (initialized && !force) {
                return;
            }
            remaining = subscriptions.length;
            while (remaining--) {
                subscriptions[remaining]['dispose']();
            }
            subscriptions.length = 0;
            elements = document['querySelectorAll']('[data-allowed-char-expr],[data-disallowed-char-expr]');
            remaining = elements.length;
            while (remaining--) {
                element = elements[remaining];
                rules = {
                    allowed: expression(element['getAttribute']('data-allowed-char-expr')),
                    disallowed: expression(element['getAttribute']('data-disallowed-char-expr'))
                };
                if (rules.allowed || rules.disallowed) {
                    subscriptions.push(bind('keypress', element, onKeypress, rules));
                }
            }
            initialized = true;
        };

    allowedChars['initialize'] = initialize;
    initialize();
});
