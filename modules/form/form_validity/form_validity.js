/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Reflect native validity for ordinary forms, retaining the original
 * data-validity-valid and data-not-allowed contracts. Submission and
 * deferred content loading belong to their own modules. Native validation
 * UI and authored novalidate/formnovalidate are preserved.
 * @requires paste/guid
 * @requires paste/ui/utilities/form-dom
 * @module paste/ui/form/form_validity
 */
paste['define']('paste.ui.form.form_validity', ['paste.guid', 'paste.ui.utilities.form-dom'], function (form, guid, formDom) {
    'use strict';

    var $getAttribute = formDom['getAttribute'],
        $setAttribute = formDom['setAttribute'],
        $hasAttribute = formDom['hasAttribute'],
        $addEventListener = formDom['addEventListener'],
        $doc = document,
        $HTMLFormElement = window['HTMLFormElement'],
        WeakMapCtor = window['WeakMap'],
        bound = WeakMapCtor ? new WeakMapCtor() : null,
        nativeValidity = $HTMLFormElement && $HTMLFormElement['prototype']['checkValidity'],
        legacyValidity = function (element) {
            return nativeValidity.call(element);
        },
        legacyInvalid = function (e) {
            $setAttribute.call(e.target, 'data-validity-valid', false);
            $setAttribute.call(e.currentTarget, 'data-validity-valid', false);
        },
        legacyChange = function (e) {
            var target = e.target;
            if (target && typeof target.checkValidity === 'function' && target.checkValidity()) {
                target.setAttribute('data-validity-valid', true);
                $setAttribute.call(this, 'data-validity-valid', legacyValidity(this));
            }
        },
        legacySubmit = function (e) {
            var submitter = e.submitter,
                valid = true;
            if (!$hasAttribute.call(this, 'novalidate') && !(submitter && submitter.formNoValidate)) {
                valid = legacyValidity(this);
                $setAttribute.call(this, 'data-validity-valid', valid);
            }
            if (!valid || $getAttribute.call(this, 'data-not-allowed') === 'true') {
                e.preventDefault();
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                forms,
                count,
                element;
            if (!bound || typeof nativeValidity !== 'function') {
                return;
            }
            if (formDom['nodeType'].call(root) === 1) {
                forms = formDom['querySelectorAll'].call(root, 'form');
            } else {
                forms = root.querySelectorAll('form');
            }
            count = forms.length;
            while (count >= 0) {
                element = count === forms.length ? root : forms[count];
                count -= 1;
                if (formDom['nodeType'].call(element) === 1 && formDom['tagName'].call(element) === 'FORM' && !bound.has(element)) {
                    bound.set(element, true);
                    if (!$getAttribute.call(element, 'id')) {
                        $setAttribute.call(element, 'id', guid['Guid']['create']());
                    }
                    $setAttribute.call(element, 'data-validity-valid', legacyValidity(element));
                    $addEventListener.call(element, 'submit', legacySubmit, false);
                    $addEventListener.call(element, 'change', legacyChange, false);
                    $addEventListener.call(element, 'focusout', legacyChange, false);
                    $addEventListener.call(element, 'keyup', legacyChange, false);
                    // invalid does not bubble; Paste subscriptions have no capture option.
                    $addEventListener.call(element, 'invalid', legacyInvalid, true);
                }
            }
        };

    form['init'] = init;
    init();
});
