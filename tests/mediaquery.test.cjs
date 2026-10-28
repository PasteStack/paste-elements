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

// The shared MediaQueryList binding: one policy for every element.
// An answer the platform cannot observe is reported as unobserved, and
// unobserved motion counts as reduced.

function list(options) {
    const mql = {
        matches: options.matches,
        added: [],
        removed: [],
        set(value) {
            mql.matches = value;
            mql.added.filter(l => mql.removed.indexOf(l) === -1).slice()
                .forEach(l => l({matches: value}));
        }
    };
    if (options.modern !== false) {
        mql.addEventListener = options.modernThrows ?
            () => { throw new Error('refused'); } :
            (name, l) => { assert.equal(name, 'change'); mql.added.push(l); };
        mql.removeEventListener = options.removeThrows ?
            () => { throw new Error('refused'); } :
            (name, l) => { mql.removed.push(l); };
    }
    if (options.legacy) {
        mql.addListener = options.legacyThrows ?
            () => { throw new Error('refused'); } :
            l => mql.added.push(l);
        mql.removeListener = l => mql.removed.push(l);
    }
    return mql;
}

function load(windowShape) {
    const context = {
        window: windowShape,
        Object,
        paste: {define(name, deps, factory) {
            assert.equal(name, 'paste.ui.utilities.mediaquery');
            assert.equal(deps.length, 0);
            context.module = factory({});
        }}
    };
    vm.runInNewContext(readModuleSource('paste/ui/utilities/mediaquery.js'), context);
    return context.module;
}

test('a modern query is observed, reports changes and removes its own listener', () => {
    const mql = list({matches: false});
    const mq = load({matchMedia: () => mql});
    const seen = [];
    const record = mq.observe('(prefers-reduced-motion: reduce)', m => seen.push(m));
    assert.equal(record.observed, true);
    assert.equal(record.matches, false);
    mql.set(true);
    assert.deepEqual(seen, [true]);
    assert.equal(record.matches, true);
    record.dispose();
    record.dispose();
    assert.equal(mql.removed.length, 1);
    assert.equal(mql.removed[0], mql.added[0]);
    mql.set(false);
    assert.deepEqual(seen, [true]);
});

test('a legacy-only query binds through addListener and removes through removeListener', () => {
    const mql = list({matches: true, modern: false, legacy: true});
    const mq = load({matchMedia: () => mql});
    const record = mq.observe('(q)', () => {});
    assert.equal(record.observed, true);
    record.dispose();
    assert.equal(mql.removed[0], mql.added[0]);
});

test('a modern registration that refuses falls back to addListener', () => {
    const mql = list({matches: false, modernThrows: true, legacy: true});
    const mq = load({matchMedia: () => mql});
    const record = mq.observe('(q)', () => {});
    assert.equal(record.observed, true);
    assert.equal(mql.added.length, 1);
});

test('an unobservable answer is reported, never thrown', () => {
    const cases = [
        {},
        {matchMedia: () => { throw new Error('hostile'); }},
        {matchMedia: () => null},
        {matchMedia: () => ({matches: 'yes', addEventListener() {}})},
        {matchMedia: () => list({matches: false, modern: false})},
        {matchMedia: () => list({matches: false, modernThrows: true})},
        {matchMedia: () => list({matches: false, modern: false, legacy: true, legacyThrows: true})}
    ];
    cases.forEach((windowShape, index) => {
        const mq = load(windowShape);
        const record = mq.observe('(q)', () => {});
        assert.equal(record.observed, false, 'case ' + index);
        assert.equal(record.matches, null, 'case ' + index);
        assert.equal(mq.motionReduced(record), true, 'case ' + index);
        record.dispose();
    });
});

test('a refused removal leaves the record inert', () => {
    const mql = list({matches: false, removeThrows: true});
    const mq = load({matchMedia: () => mql});
    const seen = [];
    const record = mq.observe('(q)', m => seen.push(m));
    record.dispose();
    mql.set(true);
    assert.deepEqual(seen, []);
});

test('observed motion follows the query; unobserved motion is reduced', () => {
    const mql = list({matches: false});
    const mq = load({matchMedia: () => mql});
    const record = mq.observe('(prefers-reduced-motion: reduce)', () => {});
    assert.equal(mq.motionReduced(record), false);
    mql.set(true);
    assert.equal(mq.motionReduced(record), true);
    assert.equal(mq.motionReduced(null), true);
});

test('matchMedia is captured at definition', () => {
    const mql = list({matches: false});
    const windowShape = {matchMedia: () => mql};
    const mq = load(windowShape);
    windowShape.matchMedia = () => { throw new Error('replaced later'); };
    assert.equal(mq.observe('(q)', () => {}).observed, true);
});

test('the resolution watch re-arms at the new ratio and stops on dispose', () => {
    const queries = [];
    const lists = [];
    const windowShape = {
        devicePixelRatio: 1,
        matchMedia: q => {
            const mql = list({matches: true});
            queries.push(q);
            lists.push(mql);
            return mql;
        }
    };
    const mq = load(windowShape);
    let changes = 0;
    const watch = mq.watchResolution(() => { changes += 1; });
    assert.deepEqual(queries, ['(resolution: 1dppx)']);
    windowShape.devicePixelRatio = 2;
    lists[0].set(false);
    assert.equal(changes, 1);
    assert.deepEqual(queries, ['(resolution: 1dppx)', '(resolution: 2dppx)']);
    assert.equal(lists[0].removed.length, 1, 'the old query listener was removed');
    watch.dispose();
    assert.equal(lists[1].removed.length, 1, 'dispose removes the live listener');
    lists[1].set(false);
    assert.equal(changes, 1);
});

test('an unobservable resolution query arms nothing', () => {
    const mq = load({devicePixelRatio: 2, matchMedia: () => { throw new Error('no'); }});
    const watch = mq.watchResolution(() => { throw new Error('never'); });
    watch.dispose();
});

test('a preference that changes without reporting it is read live', () => {
    const mql = list({matches: false});
    const mq = load({matchMedia: () => mql});
    const seen = [];
    const record = mq.observe('(prefers-reduced-motion: reduce)', m => seen.push(m));
    mql.matches = true;
    assert.deepEqual(seen, [], 'no change was reported');
    assert.equal(mq.motionReduced(record), true, 'the live answer is honoured');
});

// A matches getter that throws is no answer: at observation the query is
// unobserved (so motion counts as reduced); once observed, a live read or
// a change notice without its own answer that throws keeps the last
// known answer.
test('a throwing matches getter is contained', () => {
    const hostile = {addEventListener() {}};
    Object.defineProperty(hostile, 'matches', {get() { throw new Error('hostile'); }});
    let mq = load({matchMedia: () => hostile});
    let record;
    assert.doesNotThrow(() => { record = mq.observe('(q)', () => {}); });
    assert.equal(record.observed, false);
    assert.equal(mq.motionReduced(record), true);

    let throwing = false;
    let listener = null;
    const flaky = {addEventListener(name, l) { listener = l; }};
    Object.defineProperty(flaky, 'matches', {get() {
        if (throwing) {
            throw new Error('hostile');
        }
        return true;
    }});
    mq = load({matchMedia: () => flaky});
    const seen = [];
    record = mq.observe('(prefers-reduced-motion: reduce)', m => seen.push(m));
    assert.equal(record.observed, true);
    throwing = true;
    assert.doesNotThrow(() => mq.motionReduced(record));
    assert.equal(mq.motionReduced(record), true, 'the last known answer was lost');
    assert.doesNotThrow(() => listener({}));
    assert.deepEqual(seen, [true]);
});

test('an absent or invalid device pixel ratio watches the default density', () => {
    for (const ratio of [undefined, null, 0, -1, NaN, '2']) {
        const queries = [];
        const mq = load({devicePixelRatio: ratio, matchMedia: query => {
            queries.push(query);
            return list({matches: true});
        }});
        const watch = mq.watchResolution(() => {});
        assert.deepEqual(queries, ['(resolution: 1dppx)']);
        watch.dispose();
    }
});

for (const unreadable of ['throws', 'non-boolean']) {
    test('a reduced preference survives a matches getter that becomes ' + unreadable + ' during registration', () => {
        let registered = false;
        let listener;
        const mql = {
            get matches() {
                if (!registered) return true;
                if (unreadable === 'throws') throw new Error('matches unavailable');
                return undefined;
            },
            addEventListener(name, callback) { registered = true; listener = callback; },
            removeEventListener() {}
        };
        const mq = load({matchMedia: () => mql});
        const changes = [];
        const record = mq.observe('(prefers-reduced-motion: reduce)', value => changes.push(value));
        assert.equal(record.observed, true);
        assert.equal(mq.motionReduced(record), true, 'an unreadable live answer enabled motion');
        assert.equal(record.matches, true, 'registration lost the valid reduced-motion answer');
        listener({});
        assert.deepEqual(changes, [true], 'a change without an answer must retain the known preference');
        record.dispose();

        const normal = load({matchMedia: () => list({matches: false})});
        assert.equal(normal.motionReduced(normal.observe('(prefers-reduced-motion: reduce)', () => {})), false,
            'an observable no-preference answer still permits enhancement');
    });
}

test('disposing a resolution watch releases its media-query list', async () => {
    require('node:v8').setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    let reference;
    const mq = load({devicePixelRatio: 1, matchMedia() {
        const mql = list({matches: true});
        reference = new WeakRef(mql);
        return mql;
    }});
    const watch = mq.watchResolution(() => {});
    await new Promise(resolve => setImmediate(resolve));
    gc();
    assert.ok(reference.deref(), 'the active watch must hold its list');
    watch.dispose();
    await new Promise(resolve => setImmediate(resolve));
    gc();
    assert.equal(reference.deref(), undefined, 'a retained watch handle kept its disposed list alive');
    watch.dispose();
});
