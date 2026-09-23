/*jslint white:false plusplus:false browser:true nomen:false sub:true */
/*globals paste */

/**
 * Apply an IO reply fragment envelope: replace the content of named IO
 * reply fragment targets and write variables onto bound attributes. An
 * envelope is applied only on success (HTTP 200 and meta.code 200); anything
 * else changes nothing.
 * @module paste/ui/io-reply-fragment-envelope
 */
paste.define('paste.ui.io-reply-fragment-envelope', [], function (ioReplyFragmentEnvelope) {
    'use strict';

    // Every element carrying the attribute, root included when it does.
    var carrying = function (root, attribute) {
        var found = root.querySelectorAll ?
                    Array.prototype.slice.call(root.querySelectorAll('[' + attribute + ']')) : [];
        if (root.hasAttribute && root.hasAttribute(attribute)) {
            found.unshift(root);
        }
        return found;
    };

    /**
     * Apply an envelope produced alongside an IO reply fragment.
     * @param {Object} envelope Parsed envelope: {meta: {code}, data: {fragments, variables}}.
     * @param {number} status HTTP status the envelope arrived with.
     * @param {HTMLElement|Document} [root=document] Scope of the update.
     * @returns {number} Target elements whose content was replaced; 0 when
     * nothing was applied.
     * @example
     * paste.require(['paste.ui.io-reply-fragment-envelope'], function (module, ioReplyFragmentEnvelope) {
     *     ioReplyFragmentEnvelope.apply(envelope, status);
     * });
     */
    ioReplyFragmentEnvelope['apply'] = function (envelope, status, root) {
        var scope,
            replaced = 0,
            fragments,
            variables;

        if (status !== 200 || !envelope || typeof envelope !== 'object' ||
                !envelope.meta || envelope.meta.code !== 200 ||
                !envelope.data || typeof envelope.data !== 'object') {
            return 0;
        }
        scope = root || document;
        fragments = envelope.data.fragments;
        if (fragments && typeof fragments === 'object') {
            // Targets are collected as each name is applied: an earlier
            // entry's markup can detach a target or place a new one.
            Object.keys(fragments).forEach(function (name) {
                var entry = fragments[name];
                if (!entry || typeof entry.markup !== 'string') {
                    return;
                }
                carrying(scope, 'data-paste-io-reply-fragment-target').forEach(function ($target) {
                    if ($target.getAttribute('data-paste-io-reply-fragment-target') === name) {
                        $target.innerHTML = entry.markup;
                        replaced += 1;
                    }
                });
            });
        }
        variables = envelope.data.variables;
        if (variables && typeof variables === 'object') {
            carrying(scope, 'data-paste-io-reply-fragment-bind').forEach(function ($element) {
                var spec = $element.getAttribute('data-paste-io-reply-fragment-bind');
                if (!spec) {
                    return;
                }
                spec.split(',').forEach(function (pair) {
                    var separator = pair.indexOf('='),
                        attribute,
                        variable;
                    if (separator === -1) {
                        return;
                    }
                    attribute = pair.slice(0, separator).replace(/^\s+|\s+$/g, '');
                    variable = pair.slice(separator + 1).replace(/^\s+|\s+$/g, '');
                    // Variables are string values; anything else is ignored.
                    if (attribute && Object.prototype.hasOwnProperty.call(variables, variable)
                            && typeof variables[variable] === 'string') {
                        $element.setAttribute(attribute, variables[variable]);
                    }
                });
            });
        }
        return replaced;
    };
});
