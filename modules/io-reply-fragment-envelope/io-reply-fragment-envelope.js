/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Apply an IO reply fragment envelope: replace the content of named IO
 * reply fragment targets and write variables onto bound attributes. An
 * envelope is applied only on success (HTTP 200 and meta.code 200); anything
 * else changes nothing.
 *
 * Fragment markup is written with innerHTML: it must be trusted HTML
 * from the page's own origin. Scripts in it do not run, but every other
 * element and attribute it carries lands in the page as sent.
 * @module paste/ui/io-reply-fragment-envelope
 */
paste['define']('paste.ui.io-reply-fragment-envelope', [], function (ioReplyFragmentEnvelope) {
    'use strict';

    var $doc = document,
        $hasOwn = Object['prototype']['hasOwnProperty'],
        $keys = Object['keys'],
        TARGET = 'data-paste-io-reply-fragment-target',
        BIND = 'data-paste-io-reply-fragment-bind',
        $trim = String['prototype']['trim'],

        // Every element carrying the attribute in document order, root first
        // when it carries it too. The query result is copied so later markup
        // writes cannot shift a live walk.
        carrying = function (root, attribute) {
            var found = [],
                list,
                remaining,
                index = 0;
            if (root['hasAttribute'] && root['hasAttribute'](attribute)) {
                found.push(root);
            }
            if (root['querySelectorAll']) {
                list = root['querySelectorAll']('[' + attribute + ']');
                remaining = list.length;
                while (remaining--) {
                    found.push(list[index]);
                    index += 1;
                }
            }
            return found;
        },

        // Replace every target named `name`; returns how many were replaced.
        // A target nested in a same-named one is detached by the outer
        // write: it is skipped and not counted.
        applyFragment = function (scope, name, markup) {
            var targets = carrying(scope, TARGET),
                remaining = targets.length,
                index = 0,
                replaced = 0,
                $target;
            while (remaining--) {
                $target = targets[index];
                if ($target['getAttribute'](TARGET) === name &&
                        (!replaced || !scope['contains'] || scope['contains']($target))) {
                    $target['innerHTML'] = markup;
                    replaced += 1;
                }
                index += 1;
            }
            return replaced;
        },

        // Write each "attribute=variable" pair of one element's declaration,
        // in declared order so a later pair for the same attribute wins.
        applyBinding = function ($element, variables) {
            var spec = $element['getAttribute'](BIND),
                pairs,
                remaining,
                index = 0,
                pair,
                separator,
                attribute,
                variable;
            if (!spec) {
                return;
            }
            pairs = spec.split(',');
            remaining = pairs.length;
            while (remaining--) {
                pair = pairs[index];
                index += 1;
                separator = pair.indexOf('=');
                if (separator !== -1) {
                    attribute = $trim.call(pair.slice(0, separator));
                    variable = $trim.call(pair.slice(separator + 1));
                    // Variables are string values; anything else is ignored.
                    if (attribute && $hasOwn.call(variables, variable) &&
                            typeof variables[variable] === 'string') {
                        $element['setAttribute'](attribute, variables[variable]);
                    }
                }
            }
        };

    /**
     * Apply an envelope produced alongside an IO reply fragment.
     *
     * Fragments apply one name at a time, in the own-key order of
     * data.fragments: names that are canonical array indices ("0", "7",
     * "42") apply first, in ascending numeric order, and every other name
     * follows in the order the reply declared it. A reply whose fragments
     * nest — an outer markup that places an inner target — must give the
     * outer fragment a name that is not integer-like, or the inner one
     * applies first and is then replaced. Bound variables apply after
     * every fragment; within one bind declaration a later pair for the
     * same attribute wins.
     *
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
            meta,
            data,
            fragments,
            variables,
            names,
            name,
            entry,
            elements,
            remaining,
            index = 0;

        if (status !== 200 || !envelope || typeof envelope !== 'object') {
            return 0;
        }
        meta = envelope['meta'];
        data = envelope['data'];
        if (!meta || meta['code'] !== 200 || !data || typeof data !== 'object') {
            return 0;
        }
        scope = root || $doc;
        fragments = data['fragments'];
        if (fragments && typeof fragments === 'object') {
            // Targets are collected as each name is applied: an earlier
            // entry's markup can detach a target or place a new one, so
            // order matters and the own keys are walked forward (a cold
            // path: one walk per applied envelope). That order is the
            // language's own-key order, not the text order of the reply:
            // integer-like names ("0", "12") come first in ascending
            // numeric order, then every other name in insertion order.
            names = $keys(fragments);
            remaining = names.length;
            while (remaining--) {
                name = names[index];
                index += 1;
                entry = fragments[name];
                if (entry && typeof entry['markup'] === 'string') {
                    replaced += applyFragment(scope, name, entry['markup']);
                }
            }
            index = 0;
        }
        variables = data['variables'];
        if (variables && typeof variables === 'object') {
            elements = carrying(scope, BIND);
            remaining = elements.length;
            while (remaining--) {
                applyBinding(elements[index], variables);
                index += 1;
            }
        }
        return replaced;
    };
});
