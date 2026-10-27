/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Rich, author-supplied tooltip: data-ui-js-tooltip="class=html|class=html".
 * Hover and focus expose the same content; Escape dismisses it. Values in
 * this attribute are trusted page markup, never interpolated user input.
 * @requires paste/event
 * @module paste/ui/js_tooltip
 */
paste['define']('paste.ui.js_tooltip', ['paste.event'], function (tooltip, event) {
    'use strict';

    var $doc = document,
        $w = window,
        WeakMapCtor = $w['WeakMap'],
        bound = WeakMapCtor ? new WeakMapCtor() : null,
        bind = event['bind'],
        nextId = 0,
        hide = function (record) {
            var tokens,
                remaining;
            if (!record.flyout) {
                return;
            }
            tokens = (record.element['getAttribute']('aria-describedby') || '').split(/\s+/);
            remaining = tokens.length;
            while (remaining--) {
                if (tokens[remaining] === record.flyout['id']) {
                    tokens.splice(remaining, 1);
                }
            }
            if (tokens.join(' ').trim()) {
                record.element['setAttribute']('aria-describedby', tokens.join(' ').trim());
            } else {
                record.element['removeAttribute']('aria-describedby');
            }
            $doc['removeEventListener']('scroll', record.reposition, true);
            record.resize['dispose']();
            record.key['dispose']();
            record.flyout['remove']();
            record.flyout = null;
        },
        position = function (record) {
            var rect = record.element['getBoundingClientRect'](),
                style = record.flyout['style'],
                right = ($w['innerWidth'] - rect.left - rect.width / 2) + 'px',
                bottom = ($w['innerHeight'] - rect.top) + 'px';
            if (style['right'] !== right) {
                style['right'] = right;
            }
            if (style['bottom'] !== bottom) {
                style['bottom'] = bottom;
            }
        },
        onKey = function (e) {
            if (e['key'] === 'Escape' || e['keyCode'] === 27) {
                this.dismissed = true;
                hide(this);
            }
        },
        show = function (record) {
            var declaration = record.element['getAttribute']('data-ui-js-tooltip'),
                parts,
                remaining,
                index = 0,
                part,
                separator,
                child,
                flyout,
                id,
                described;
            if (record.flyout || record.dismissed || !declaration) {
                return;
            }
            flyout = $doc['createElement']('div');
            parts = declaration.split('|');
            remaining = parts.length;
            while (remaining--) {
                part = parts[index];
                index += 1;
                separator = part.indexOf('=');
                if (separator !== -1) {
                    child = $doc['createElement']('div');
                    child['className'] = part.slice(0, separator);
                    child['innerHTML'] = part.slice(separator + 1);
                    flyout['appendChild'](child);
                }
            }
            if (!flyout['firstChild']) {
                return;
            }
            do {
                nextId += 1;
                id = 'paste-ui-tooltip-' + nextId;
            } while ($doc['getElementById'](id));
            flyout['id'] = id;
            flyout['className'] = 'ui-js-tooltip';
            flyout['setAttribute']('role', 'tooltip');
            described = record.element['getAttribute']('aria-describedby');
            record.flyout = flyout;
            position(record);
            $doc.body['appendChild'](flyout);
            record.reposition = function () {
                position(record);
            };
            // Scroll does not bubble and Paste subscriptions have no capture
            // option. Capture only while this tooltip is visible.
            $doc['addEventListener']('scroll', record.reposition, true);
            record.resize = bind('resize', $w, record.reposition);
            record.key = bind('keydown', $doc, onKey, record);
            record.element['setAttribute']('aria-describedby', (described ? described + ' ' : '') + id);
        },
        enter = function (e) {
            if (e.type === 'mouseenter') {
                this.hovered = true;
            } else {
                this.focused = true;
            }
            show(this);
        },
        leave = function (e) {
            if (e.type === 'mouseleave') {
                this.hovered = false;
            } else if (!e['relatedTarget'] || !this.element['contains'](e['relatedTarget'])) {
                this.focused = false;
            }
            if (!this.hovered && !this.focused) {
                hide(this);
                this.dismissed = false;
            }
        },
        init = function (parent) {
            var root = parent || $doc,
                elements,
                remaining,
                element,
                record;
            if (!bound) {
                return;
            }
            elements = root['querySelectorAll']('[data-ui-js-tooltip]');
            remaining = elements.length;
            while (remaining >= 0) {
                element = remaining === elements.length ? root : elements[remaining];
                remaining -= 1;
                if (element['hasAttribute'] && element['hasAttribute']('data-ui-js-tooltip') && !bound.get(element)) {
                    record = {element: element, flyout: null, hovered: false, focused: false, dismissed: false};
                    bound.set(element, record);
                    bind('mouseenter', element, enter, record);
                    bind('mouseleave', element, leave, record);
                    bind('focusin', element, enter, record);
                    bind('focusout', element, leave, record);
                }
            }
        };

    tooltip['init'] = init;
    init();
});
