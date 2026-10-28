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
 * An explicitly opted-in control navigates to its value on change. A
 * select remains a select; ordinary destinations remain anchors. The
 * browser owns navigation, URL resolution and history.
 * @requires paste/event
 * @module paste/ui/navigate_on_change
 */
paste['define']('paste.ui.navigate_on_change', ['paste.event'], function (navigateOnChange, event) {
    'use strict';

    var attribute = 'data-navigate-on-change';

    event['bind']('change', document.documentElement, function (e) {
        var element = event['getEventTarget'](e),
            declaration = element['getAttribute'] && element['getAttribute'](attribute);
        if (!e['defaultPrevented'] && declaration && declaration.toLowerCase() === 'true' &&
                typeof element['value'] === 'string') {
            window.location['assign'](element['value']);
        }
    });
    return navigateOnChange;
});
