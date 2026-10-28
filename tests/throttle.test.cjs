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

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {readModuleSource} = require('./fakes.cjs');

// Deliberate contract restoration: first call, leading-only. Preserve
// source-derived default windows and property-key sharing for explicit IDs.
// Timers model native asynchronous delivery, never sync.
function load() {
    const timers = [];
    const host = {refuse: false};
    let throttle;
    vm.runInNewContext(readModuleSource('paste/ui/utilities/throttle.js'), {
        setTimeout(fn, delay) {
            if (host.refuse) { throw new Error('timer refused'); }
            timers.push({fn, delay});
            return timers.length;
        },
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.utilities.throttle');
            assert.equal(deps.length, 0);
            throttle = factory({});
        }}
    });
    return {throttle, host, timers, expire() { timers.shift().fn(); }};
}

test('delayed mode retains the first context and complete argument list', () => {
    const f = load(), calls = [], first = {name: 'first'};
    const wrapped = f.throttle(function (...args) { calls.push([this, args]); }, 50);
    wrapped.call(first, 1, 'a');
    wrapped.call({}, 2, 'b');
    wrapped.call({}, 3);
    assert.equal(calls.length, 0);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, 50);
    f.expire();
    assert.deepEqual(calls, [[first, [1, 'a']]]);
    assert.equal(f.timers.length, 0);
    wrapped.call(first, 4);
    f.expire();
    assert.deepEqual(calls[1], [first, [4]]);
});

test('runFirst executes immediately and never adds a trailing invocation', () => {
    const f = load(), calls = [], first = {};
    const wrapped = f.throttle(function (...args) { calls.push([this, args]); }, 70, null, true);
    wrapped.call(first, 1, 'a');
    wrapped(2);
    wrapped(3);
    assert.deepEqual(calls, [[first, [1, 'a']]]);
    assert.equal(f.timers[0].delay, 70);
    f.expire();
    assert.equal(calls.length, 1);
    assert.equal(f.timers.length, 0);
    wrapped(4);
    assert.deepEqual(calls.map(c => c[1][0]), [1, 4]);
});

for (const leading of [false, true]) {
    test(`reentry is discarded in ${leading ? 'leading' : 'delayed'} mode`, () => {
        const f = load(), calls = [];
        const wrapped = f.throttle(n => { calls.push(n); wrapped(n + 1); }, 20, null, leading);
        wrapped(1);
        f.expire();
        assert.deepEqual(calls, [1]);
        assert.equal(f.timers.length, 0);
        wrapped(3);
        f.expire();
        assert.deepEqual(calls, [1, 3]);
    });
    test(`throwing ${leading ? 'leading' : 'delayed'} callbacks cannot strand a window`, () => {
        const f = load();
        let calls = 0;
        const wrapped = f.throttle(() => { calls += 1; if (calls === 1) { throw new Error('boom'); } }, 20, 'shared', leading);
        if (leading) {
            assert.throws(wrapped, /boom/);
            wrapped();
            f.expire();
        } else {
            wrapped();
            assert.throws(() => f.expire(), /boom/);
        }
        assert.equal(calls, 1);
        wrapped();
        f.expire();
        assert.equal(calls, 2);
    });
}

test('idless wrappers share by function source and period', () => {
    const f = load(), calls = [];
    const fn = n => calls.push(n), a = f.throttle(fn, 10), b = f.throttle(fn, 10);
    a(1); b(2); a(3); b(4);
    assert.equal(f.timers.length, 1);
    f.expire();
    assert.deepEqual(calls, [1]);
});

test('an explicit id shares the first caller\'s function, period and mode', () => {
    const f = load(), calls = [];
    const a = f.throttle(n => calls.push(['a', n]), 10, 'shared');
    const b = f.throttle(n => calls.push(['b', n]), 90, 'shared', true);
    a(1); b(2);
    assert.equal(calls.length, 0);
    assert.equal(f.timers.length, 1);
    assert.equal(f.timers[0].delay, 10);
    f.expire();
    assert.deepEqual(calls, [['a', 1]]);
    b(3); a(4);
    assert.deepEqual(calls, [['a', 1], ['b', 3]]);
    assert.equal(f.timers[0].delay, 90);
    f.expire();
    assert.equal(calls.length, 2);
});

for (const [label, first, second, shared] of [
    ['same string', 'x', 'x', true],
    ['number and string', 1, '1', true],
    ['distinct objects', {}, {}, true],
    ['prototype name', '__proto__', '__proto__', true],
    ['constructor name', 'constructor', 'constructor', true],
    ['zero falls back to function source', 0, 0, false]
]) {
    test(`id identity: ${label}`, () => {
        const f = load(), calls = [];
        f.throttle(() => calls.push(1), 10, first)();
        f.throttle(() => calls.push(2), 10, second)();
        while (f.timers.length) { f.expire(); }
        assert.deepEqual(calls, shared ? [1] : [1, 2]);
    });
}

test('explicit object ids retain property-key coercion', () => {
    const f = load(), id = {toString() { return 'shared'; }}, calls = [];
    f.throttle(() => calls.push(1), 10, id)();
    f.throttle(() => calls.push(2), 10, id)();
    f.expire();
    assert.deepEqual(calls, [1]);
});

test('a failed timer registration releases both default and explicit windows', () => {
    const f = load(), calls = [];
    const a = f.throttle(() => calls.push('a'), 10, 'key');
    const b = f.throttle(() => calls.push('b'), 10, 'key');
    f.host.refuse = true;
    assert.throws(a, /timer refused/);
    f.host.refuse = false;
    b(); f.expire(); a(); f.expire();
    assert.deepEqual(calls, ['b', 'a']);
});

test('explicit ids retain string-hint coercion and symbol identity',()=>{
 const f=load(),calls=[],id={toString(){return 'named';},valueOf(){return 42;}};
 f.throttle(()=>calls.push(1),10,id)();f.throttle(()=>calls.push(2),10,'named')();f.expire();assert.deepEqual(calls,[1]);
 const symbol=Symbol('named');f.throttle(()=>calls.push(3),10,symbol)();f.throttle(()=>calls.push(4),10,symbol)();f.expire();assert.deepEqual(calls,[1,3]);
});

test('a mutable explicit key cannot strand its previously occupied window',()=>{
 const f=load(),calls=[];let name='first';const id={toString(){return name;}};
 const wrapped=f.throttle(()=>calls.push(name),10,id);wrapped();name='second';wrapped();
 f.expire();f.expire();name='first';wrapped();assert.equal(f.timers.length,1);f.expire();assert.equal(calls.length,3);
});

test('an object converting to a symbol shares the native property key', () => {
    const f = load(), calls = [], key = Symbol('key');
    const id = {[Symbol.toPrimitive](hint) { assert.equal(hint, 'string'); return key; }};
    const first = f.throttle(() => calls.push(1), 10, id);
    const second = f.throttle(() => calls.push(2), 10, key);
    first(); second(); f.expire(); second(); f.expire();
    assert.deepEqual(calls, [1, 2]);
});
