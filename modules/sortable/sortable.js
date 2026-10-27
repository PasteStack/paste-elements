/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Swap the contents of draggable slots, leaving structural blocks and
 * their order fields in place. Blocks use .paste-ui-sortable; each contains one draggable="true" slot. Activate
 * the group with data-paste-sortable or bind(parent, callbacks).
 * @requires paste/event
 * @module paste/ui/sortable
 */
paste['define']('paste.ui.sortable', ['paste.event'], function (sortable, event) {
    'use strict';

    var $doc = document,
        WeakMapCtor = window['WeakMap'],
        bound = WeakMapCtor ? new WeakMapCtor() : null,
        subscribe = event['bind'],
        create = function (parent, record) {
            var blocks = parent['querySelectorAll']('.paste-ui-sortable'),
                draggables = [],
                source = null,
                initialized = false,
                notify = function (name, slot) {
                    if (typeof record.callbacks[name] === 'function') {
                        record.callbacks[name].call(slot.element, parent, slot.block);
                    }
                },
                clear = function () {
                    var count = draggables.length;
                    while (count--) {
                        draggables[count]['classList'].remove('dragging', 'over');
                    }
                    source = null;
                },
                onStart = function (e) {
                    if (e['defaultPrevented'] || !e['dataTransfer'] || e['target'] !== this.element) {
                        return;
                    }
                    source = this.element;
                    source['classList'].add('dragging');
                    e['dataTransfer']['effectAllowed'] = 'move';
                    e['dataTransfer']['setData']('text/plain', source['textContent']);
                    notify('dragStart', this);
                },
                onEnter = function () {
                    if (source) {
                        this.element['classList'].add('over');
                        notify('dragEnter', this);
                    }
                },
                onOver = function (e) {
                    if (source && e['dataTransfer']) {
                        e['preventDefault']();
                        e['dataTransfer']['dropEffect'] = 'move';
                    }
                },
                onLeave = function (e) {
                    if (!e['relatedTarget'] || !this.element['contains'](e['relatedTarget'])) {
                        this.element['classList'].remove('over');
                    }
                },
                onDrop = function (e) {
                    var target = this.element,
                        held;
                    if (!source) {
                        return;
                    }
                    e['preventDefault']();
                    e['stopPropagation']();
                    if (source !== target) {
                        held = $doc['createDocumentFragment']();
                        while (source['firstChild']) {
                            held['appendChild'](source['firstChild']);
                        }
                        while (target['firstChild']) {
                            source['appendChild'](target['firstChild']);
                        }
                        target['appendChild'](held);
                    }
                },
                onEnd = function () {
                    clear();
                    notify('dragEnd', this);
                },
                init = function () {
                    var count = blocks.length,
                        block,
                        element,
                        slot;
                    if (initialized) {
                        return;
                    }
                    // Resolve the authored block/slot relationship before binding.
                    while (count--) {
                        block = blocks[count];
                        element = block['querySelector']('[draggable="true"]');
                        if (!element) {
                            throw new Error('Each sortable block needs a draggable="true" slot.');
                        }
                        draggables[count] = element;
                    }
                    count = blocks.length;
                    while (count--) {
                        slot = {element: draggables[count], block: blocks[count]};
                        subscribe('dragstart', slot.element, onStart, slot);
                        subscribe('dragenter', slot.element, onEnter, slot);
                        subscribe('dragover', slot.element, onOver, slot);
                        subscribe('dragleave', slot.element, onLeave, slot);
                        subscribe('drop', slot.element, onDrop, slot);
                        subscribe('dragend', slot.element, onEnd, slot);
                    }
                    initialized = true;
                };
            init();
            return {'$parent': parent, '$blocks': blocks, '$draggables': draggables, 'init': init};
        },
        bind = function (parent, callbacks) {
            var record;
            if (typeof parent === 'string') {
                parent = $doc['querySelector'](parent);
            }
            if (!parent || !parent['querySelectorAll']) {
                throw new Error('Invalid sortable parent.');
            }
            record = bound && bound.get(parent);
            if (!record) {
                record = {callbacks: callbacks || {}};
                record.instance = create(parent, record);
                if (bound) {
                    bound.set(parent, record);
                }
            } else if (callbacks) {
                record.callbacks = callbacks;
            }
            return record.instance;
        },
        groups = $doc['querySelectorAll']('[data-paste-sortable]'),
        remaining = groups.length;

    sortable['bind'] = bind;
    while (remaining--) {
        bind(groups[remaining]);
    }
});
