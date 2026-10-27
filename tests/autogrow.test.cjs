const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// Owner contract: only grow overflowing declared textareas. Geometry is
// a CSS box model, input events carry a real target. No collapse/shrink,
// frame queues or synthetic synchronous scheduler requirements.
function fixture(configs = [], options = {}) {
    const operations = [], handlers = [];
    const elements = configs.map((cfg, index) => {
        const listeners = {}, box = Object.assign({boxSizing: 'content-box', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', maxHeight: 'none'}, cfg.computed);
        let inline = cfg.inline || '', priority = cfg.priority || '';
        const el = {nodeType: 1, nodeName: cfg.nodeName || 'TEXTAREA', marked: cfg.marked !== false, legacy: !!cfg.legacy,
            client: cfg.client === undefined ? 80 : cfg.client,
            content: cfg.content === undefined ? 80 : cfg.content,
            computedHeight: cfg.height || '80px', box,
            style: {get height() { return inline; }, getPropertyPriority() { return priority; }, setProperty(name, value, important) {
                assert.equal(name, 'height');
                operations.push([index, 'height', value]);
                inline = value; priority = important;
                if (!cfg.transition) {
                    el.computedHeight = value;
                    el.client = parseFloat(value) + (box.boxSizing === 'border-box'
                        ? -parseFloat(box.borderTopWidth) - parseFloat(box.borderBottomWidth)
                        : parseFloat(box.paddingTop) + parseFloat(box.paddingBottom));
                }
            }},
            get clientHeight() { operations.push([index, 'client']); return el.client; },
            contains(other) { return (cfg.contains || []).includes(elements.indexOf(other)); },
            get scrollHeight() { operations.push([index, 'scroll']); return Math.max(el.client, cfg.child === undefined ? el.content : elements[cfg.child].client); },
            fire(type) { for (const fn of listeners[type] || []) { fn({target: el}); } },
            listen(type, fn) { (listeners[type] ||= []).push(fn); handlers.push({type, fn, el}); }
        };
        return el;
    });
    const api = {};
    vm.runInNewContext(readModuleSource('paste/ui/autogrow.js'), {
        window: options.noStyle ? {} : {getComputedStyle(el) {
            operations.push([elements.indexOf(el), 'style']);
            return Object.assign({}, el.box, {height: el.computedHeight});
        }},
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.autogrow');
            assert.deepEqual(Array.from(deps), ['paste.dom', 'paste.event']);
            factory(api, {get(selector, all) {
                assert.equal(selector, '.autogrow, textarea[data-paste-autogrow]'); assert.equal(all, true);
                return elements.filter(el => el.legacy || (el.marked && el.nodeName === 'TEXTAREA'));
            }}, {getEventTarget: e => e.target, bind(type, el, fn) { el.listen(type, fn); }});
        }}
    });
    return {elements, operations, handlers, api};
}
const writes = f => f.operations.filter(op => op[1] === 'height');

test('initial content grows a declared textarea; unrelated elements stay untouched', () => {
    const f = fixture([{content: 140}, {content: 140, marked: false}, {content: 140, nodeName: 'INPUT'}]);
    assert.deepEqual(writes(f), [[0, 'height', '140px']]);
    assert.equal(f.handlers.length, 2);
    assert.deepEqual(Object.keys(f.api), []);
});

test('all fields reuse one handler for input and legacy keyup', () => {
    const f = fixture([{}, {}, {}]);
    assert.deepEqual(f.handlers.map(h => h.type), ['input', 'keyup', 'input', 'keyup', 'input', 'keyup']);
    assert.equal(new Set(f.handlers.map(h => h.fn)).size, 1);
    f.elements[0].content = 140;
    f.elements[0].fire('input');
    assert.equal(f.elements[0].style.height, '140px');
    assert.equal(f.elements[1].style.height, '');
});

test('fitting input reads only the box heights and makes no style lookup or write', () => {
    const f = fixture([{}]);
    f.operations.length = 0;
    f.elements[0].fire('input');
    assert.deepEqual(f.operations, [[0, 'client'], [0, 'scroll']]);
});

test('delete, cut and undo never shrink an already grown field', () => {
    const f = fixture([{content: 200}]), el = f.elements[0];
    for (const content of [100, 0, 40]) { el.content = content; el.fire('input'); }
    assert.equal(el.style.height, '200px');
    assert.equal(writes(f).length, 1);
});

test('content-box height subtracts padding from scrollHeight', () => {
    const f = fixture([{client: 100, content: 180, computed: {paddingTop: '10px', paddingBottom: '10px'}}]);
    assert.equal(f.elements[0].style.height, '160px');
    f.elements[0].fire('input');
    assert.equal(writes(f).length, 1);
});

test('border-box height adds borders to scrollHeight', () => {
    const f = fixture([{client: 76, content: 180, computed: {boxSizing: 'border-box', borderTopWidth: '1.5px', borderBottomWidth: '2.5px'}}]);
    assert.equal(f.elements[0].style.height, '184px');
    f.elements[0].fire('input');
    assert.equal(writes(f).length, 1);
});

test('CSS max height stops growth and repeated writes at the cap', () => {
    const f = fixture([{content: 600, computed: {maxHeight: '200px'}}]), el = f.elements[0];
    assert.equal(el.style.height, '200px');
    el.fire('input'); el.fire('input');
    assert.equal(writes(f).length, 1);
});

test('a CSS cap below the existing height cannot shrink the field', () => {
    const f = fixture([{content: 600, computed: {maxHeight: '40px'}}]);
    assert.equal(writes(f).length, 0);
});

test('hidden fields wait for visible input before measuring content', () => {
    const f = fixture([{client: 0, content: 400}]), el = f.elements[0];
    assert.deepEqual(f.operations, [[0, 'client']]);
    el.client = 80; el.fire('input');
    assert.equal(el.style.height, '400px');
});

test('a taller inline transition target survives input while the animation is running', () => {
    const f = fixture([{content: 140, inline: '240px', transition: true}]);
    assert.equal(f.elements[0].style.height, '240px');
    assert.equal(writes(f).length, 0);
});

test('growth preserves an inline height priority', () => {
    const f = fixture([{content: 140, inline: '80px', priority: 'important'}]);
    assert.equal(f.elements[0].style.height, '140px');
    assert.equal(f.elements[0].style.getPropertyPriority('height'), 'important');
});

test('manual enlargement is retained when content fits', () => {
    const f = fixture([{content: 120, height: '200px', inline: '200px', client: 200}]);
    f.elements[0].fire('input');
    assert.equal(writes(f).length, 0);
});

test('no fields or no computed-style capability leaves the baseline alone', () => {
    assert.equal(fixture().handlers.length, 0);
    const f = fixture([{content: 140}], {noStyle: true});
    assert.equal(f.handlers.length, 0);
    assert.equal(f.operations.length, 0);
});

test('legacy class-only fields grow at initialization and keyup', () => {
 const f=fixture([{legacy:true,marked:false,nodeName:'DIV',content:140}]);
 assert.equal(f.elements[0].style.height,'140px');
 f.elements[0].content=180;f.elements[0].fire('keyup');
 assert.equal(f.elements[0].style.height,'180px');
});


test('initial overflow reads all field boxes before the first height write', () => {
 const f=fixture([{content:200},{content:300},{content:400}]);
 const first=f.operations.findIndex(op=>op[1]==='height');assert.ok(first>0);
 assert.ok(f.operations.slice(first).every(op=>op[1]==='height'));
 assert.deepEqual(f.elements.map(e=>e.style.height),['200px','300px','400px']);
});


test('nested legacy fields commit descendant growth before measuring their ancestor', () => {
 const f=fixture([{legacy:true,nodeName:'DIV',child:1,contains:[1]},{content:200}]);
 assert.deepEqual(f.elements.map(e=>e.style.height),['200px','200px']);
 const childWrite=f.operations.findIndex(op=>op[0]===1&&op[1]==='height');
 const ancestorRead=f.operations.findIndex(op=>op[0]===0&&op[1]==='scroll');
 assert.ok(childWrite<ancestorRead);
});
