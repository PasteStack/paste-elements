/*jslint browser:true plusplus:true sub:true regexp:true */
/*globals paste */

/**
 * Reflect named input values into authored %(name)s text placeholders.
 * data-update-variable-name names an input; data-update-variable-names
 * lists an output's variables. Authored markup stays in place. Values
 * are text, never HTML, attributes, URLs, styles or script source.
 * @requires paste/event
 * @module paste/ui/update_text_on_input_change
 */
paste['define']('paste.ui.update_text_on_input_change', ['paste.event'], function (updateText, event) {
    'use strict';

    var $doc = document,
        WeakMapCtor = window['WeakMap'],
        bound = WeakMapCtor ? new WeakMapCtor() : null,
        values = Object['create'](null),
        defaults = Object['create'](null),
        outputs = [],
        changed = false,
        bind = event['bind'],
        INPUT = 'data-update-variable-name',
        OUTPUT = 'data-update-variable-names',
        setVariable = function (name, value) {
            if (values[name] !== value) {
                values[name] = value;
                changed = true;
            }
        },
        updateOutputs = function (force) {
            var remaining = outputs.length,
                output,
                count,
                index,
                part,
                value,
                text;
            if (!force && !changed) {
                return;
            }
            while (remaining--) {
                output = outputs[remaining];
                text = '';
                count = output.parts.length;
                index = 0;
                // Parts are a text template: their order is meaningful.
                while (count--) {
                    part = output.parts[index];
                    index += 1;
                    if (typeof part === 'string') {
                        text += part;
                    } else {
                        value = values[part.name];
                        if (value === undefined || value === null || value === '') {
                            value = defaults[part.name];
                        }
                        text += value === undefined || value === null || value === '' ? '??' : String(value);
                    }
                }
                if (output.node['nodeValue'] !== text) {
                    output.node['nodeValue'] = text;
                }
            }
            changed = false;
        },
        readInput = function (element) {
            var type = element['type'],
                value = element['value'];
            if (type === 'radio' && !element['checked']) {
                return;
            }
            if (type === 'checkbox' && !element['checked']) {
                value = '';
            }
            setVariable(element['getAttribute'](INPUT), value);
        },
        onInput = function () {
            readInput(this);
            updateOutputs();
        },
        bindOutput = function (element) {
            var names = element['getAttribute'](OUTPUT).split(','),
                allowed = Object['create'](null),
                remaining = names.length,
                original = element['getAttribute']('data-original-value'),
                walker,
                node,
                parent,
                excluded,
                text,
                pattern,
                match,
                start,
                parts;
            while (remaining--) {
                allowed[names[remaining].trim()] = true;
            }
            if (original !== null) {
                // Only the page-authored template is parsed as markup.
                element['innerHTML'] = original;
            } else {
                element['setAttribute']('data-original-value', element['innerHTML']);
            }
            walker = $doc['createTreeWalker'](element, 4);
            node = walker['nextNode']();
            while (node) {
                parent = node['parentElement'];
                excluded = false;
                while (parent) {
                    if (/^(SCRIPT|STYLE|TEXTAREA)$/.test(parent['tagName']) ||
                            (parent !== element && parent['hasAttribute'](OUTPUT))) {
                        excluded = true;
                        break;
                    }
                    if (parent === element) {
                        break;
                    }
                    parent = parent['parentElement'];
                }
                if (!excluded) {
                    text = node['nodeValue'];
                    pattern = /%\(([^)]+)\)s/g;
                    match = pattern.exec(text);
                    start = 0;
                    parts = [];
                    while (match) {
                        if (allowed[match[1]]) {
                            parts.push(text.slice(start, match.index), {name: match[1]});
                            start = match.index + match[0].length;
                        }
                        match = pattern.exec(text);
                    }
                    if (parts.length) {
                        parts.push(text.slice(start));
                        outputs.push({node: node, parts: parts});
                    }
                }
                node = walker['nextNode']();
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                elements,
                remaining,
                index = 0,
                element,
                name,
                replacesMarkup;
            if (!bound) {
                return;
            }
            remaining = outputs.length;
            while (remaining--) {
                if (!$doc['documentElement']['contains'](outputs[remaining].node) &&
                        !root['contains'](outputs[remaining].node)) {
                    outputs.splice(remaining, 1);
                }
            }
            elements = root['querySelectorAll']('[' + INPUT + '],[' + OUTPUT + ']');
            remaining = elements.length;
            while (remaining >= 0) {
                // Bind ancestor templates before their descendants: an
                // authored original template may replace the descendant nodes.
                element = remaining === elements.length ? root : elements[index++];
                remaining -= 1;
                if (element['hasAttribute'] && !bound.get(element) &&
                        (element === root || root['contains'](element))) {
                    if (element['hasAttribute'](INPUT)) {
                        name = element['getAttribute'](INPUT);
                        defaults[name] = element['getAttribute']('data-update-variable-default');
                        readInput(element);
                        bind('input', element, onInput, element);
                        bind('change', element, onInput, element);
                        bind('focusout', element, onInput, element);
                        bound.set(element, true);
                    }
                    if (element['hasAttribute'](OUTPUT)) {
                        replacesMarkup = element['hasAttribute']('data-original-value');
                        bindOutput(element);
                        bound.set(element, true);
                        if (replacesMarkup) {
                            // A supplied template can introduce fresh declarations.
                            init(element);
                        }
                    }
                }
            }
            updateOutputs(true);
        };

    updateText['init'] = init;
    updateText['setVariable'] = setVariable;
    updateText['updateOutputs'] = updateOutputs;
    init();
});
