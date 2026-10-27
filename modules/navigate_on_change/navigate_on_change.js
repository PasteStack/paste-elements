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
