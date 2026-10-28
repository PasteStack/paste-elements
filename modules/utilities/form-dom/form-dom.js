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
 * Native operations used on forms, where controls can shadow DOM members.
 * These are captured once; callers invoke them with the node as receiver.
 * No discovery, bindings, generic property dispatch or prototype walk.
 * @module paste/ui/utilities/form-dom
 */
paste['define']('paste.ui.utilities.form-dom', [], function (formDom) {
    'use strict';

    var element = window['Element']['prototype'],
        node = window['Node']['prototype'],
        events = window['EventTarget']['prototype'];

    formDom['getAttribute'] = element['getAttribute'];
    formDom['setAttribute'] = element['setAttribute'];
    formDom['hasAttribute'] = element['hasAttribute'];
    formDom['removeAttribute'] = element['removeAttribute'];
    formDom['querySelectorAll'] = element['querySelectorAll'];
    formDom['insertBefore'] = node['insertBefore'];
    formDom['appendChild'] = node['appendChild'];
    formDom['addEventListener'] = events['addEventListener'];
    formDom['dispatchEvent'] = events['dispatchEvent'];
    formDom['classList'] = Object['getOwnPropertyDescriptor'](element, 'classList').get;
    formDom['tagName'] = Object['getOwnPropertyDescriptor'](element, 'tagName').get;
    formDom['nodeType'] = Object['getOwnPropertyDescriptor'](node, 'nodeType').get;
    formDom['parentElement'] = Object['getOwnPropertyDescriptor'](node, 'parentElement').get;
    formDom['firstChild'] = Object['getOwnPropertyDescriptor'](node, 'firstChild').get;
});
