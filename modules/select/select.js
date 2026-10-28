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
 * Reflect a native single select's visible option label into its next
 * [data-paste-select-value] sibling. The select remains the real control.
 * @requires paste/event
 * @requires paste/ui/utilities/form-dom
 * @module paste/ui/select
 */
paste['define']('paste.ui.select', ['paste.event', 'paste.ui.utilities.form-dom'], function (select, event, formDom) {
    'use strict';

    var $doc = document,
        WeakMapCtor = window['WeakMap'],
        bound = WeakMapCtor ? new WeakMapCtor() : null,
        forms = bound ? new WeakMapCtor() : null,
        bind = event['bind'],
        getElements = Object['getOwnPropertyDescriptor'](window['HTMLFormElement']['prototype'], 'elements').get,
        DECLARATION = 'data-paste-select',
        READY = 'data-paste-select-ready',
        reflect = function (element) {
            var output = element['nextElementSibling'],
                option,
                label;
            if (!element['hasAttribute'](DECLARATION) || element['multiple'] || element['size'] > 1 ||
                    !output || !output['hasAttribute']('data-paste-select-value')) {
                element['removeAttribute'](READY);
                return false;
            }
            option = element['options'][element['selectedIndex']];
            label = option ? option['label'] : '';
            if (output['textContent'] !== label) {
                output['textContent'] = label;
            }
            if (!element['hasAttribute'](READY)) {
                element['setAttribute'](READY, '');
            }
            return true;
        },
        onChange = function () {
            reflect(this);
        },
        onReset = function (reset) {
            var form = this;
            if (reset['defaultPrevented']) {
                return;
            }
            // Reset dispatch precedes the browser restoring selected options.
            window['setTimeout'](function () {
                var elements,
                    remaining,
                    element;
                if (reset['defaultPrevented']) {
                    return;
                }
                // The native getter includes controls associated with form=,
                // even when a named control shadows form.elements.
                elements = getElements.call(form);
                remaining = elements.length;
                while (remaining--) {
                    element = elements[remaining];
                    if (bound.has(element)) {
                        reflect(element);
                    }
                }
            }, 0);
        },
        initialize = function (element) {
            var form;
            if (reflect(element)) {
                if (!bound.has(element)) {
                    bind('change', element, onChange, element);
                    bound.set(element, true);
                }
                form = element['form'];
                if (form && !forms.has(form)) {
                    formDom['addEventListener'].call(form, 'reset', onReset, false);
                    forms.set(form, true);
                }
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                elements,
                remaining;
            if (!bound) {
                return;
            }
            if (formDom['nodeType'].call(root) === 1 && formDom['tagName'].call(root) === 'SELECT' && root['hasAttribute'](DECLARATION)) {
                initialize(root);
            }
            if (formDom['nodeType'].call(root) === 1) {
                elements = formDom['querySelectorAll'].call(root, 'select[' + DECLARATION + ']');
            } else {
                elements = root.querySelectorAll('select[' + DECLARATION + ']');
            }
            remaining = elements.length;
            while (remaining--) {
                initialize(elements[remaining]);
            }
        };

    select['init'] = init;
    init();
});
