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

// The cssmath contract: one data attribute names a function, property and
// same-unit arguments. CSS.supports leaves native declarations alone; a
// fallback writes once, and random draws once per element and attribute.
// Parser behavior is covered here; real engines are covered by browser checks.

const moduleSource = readModuleSource('paste/ui/polyfills/cssmath.js');
const functionNames = [
    'min', 'max', 'clamp', 'round', 'mod', 'rem', 'sin', 'cos', 'tan',
    'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log',
    'exp', 'abs', 'sign', 'progress', 'random'
];
const mathNames = [
    'E', 'PI', 'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'cos', 'exp',
    'floor', 'log', 'max', 'min', 'pow', 'random', 'sign', 'sin', 'sqrt', 'tan'
];
const allAttributesSelector = '[' + 'data-paste-ui-polyfills-cssmath-' +
    functionNames.join('],[data-paste-ui-polyfills-cssmath-') + ']';

function writtenNumber(value) {
    if (Number.isNaN(value)) {
        return 0;
    }
    if (value === Infinity || value === -Infinity) {
        return undefined;
    }
    if (value === 0) {
        return 0;
    }
    if (String(value).indexOf('e') !== -1) {
        return Math.abs(value) < 1 ? 0 : undefined;
    }
    return value;
}

function equalNumber(actual, expected, message) {
    const written = writtenNumber(expected);
    assert.ok(Object.is(actual, written), message || `${actual} is not Object.is-equal to ${written}`);
}

function closeNumber(actual, expected, message) {
    const written = writtenNumber(expected);
    if (written === undefined) {
        assert.equal(actual, undefined, message || `${actual} is not an omitted result`);
        return;
    }
    assert.ok(Math.abs(actual - written) < 1e-14, message || `${actual} is not close to ${written}`);
}

function formatValue(value) {
    if (Object.is(value, -0)) {
        return '-0';
    }
    if (value === Infinity) {
        return 'infinity';
    }
    if (value === -Infinity) {
        return '-infinity';
    }
    if (Number.isNaN(value)) {
        return 'NaN';
    }
    return String(value);
}

function formatArguments(name, args) {
    let values = args;
    if (name === 'round') {
        values = args.slice(1);
        if (args[0] !== undefined) {
            values.unshift(args[0]);
        }
    } else if (name === 'random') {
        values = args.slice(1);
    }
    if (name === 'round' || name === 'log' || name === 'random') {
        while (values.length && values[values.length - 1] === undefined) {
            values.pop();
        }
    }
    for (let index = 0; index < values.length; index += 1) {
        values[index] = formatValue(values[index]);
    }
    return {
        text: values.join(', '),
        randomBase: name === 'random' ? args[0] : undefined
    };
}

function makeElement(declarations) {
    const writes = [];
    const writeProperties = [];
    const style = {
        setProperty(property, value) {
            writes.push(value);
            writeProperties.push(property);
        }
    };
    return {
        element: {
            style,
            getAttribute(name) {
                return Object.prototype.hasOwnProperty.call(declarations, name) ?
                    declarations[name] : null;
            }
        },
        writes,
        writeProperties,
        value() { return writes.length ? writes[writes.length - 1] : undefined; }
    };
}

function runPage(name, declarationTexts, options) {
    const attribute = 'data-paste-ui-polyfills-cssmath-' + name;
    const selectors = [];
    const supportsCalls = [];
    const values = [];
    const writes = [];
    const writeProperties = [];
    let randomCalls = 0;
    let namespace;
    const elements = [];
    const records = [];
    for (let index = 0; index < declarationTexts.length; index += 1) {
        const declaration = declarationTexts[index];
        let declarations;
        if (typeof declaration === 'string') {
            declarations = {[attribute]: declaration};
        } else {
            declarations = {};
            for (const mathName of Object.keys(declaration)) {
                declarations['data-paste-ui-polyfills-cssmath-' + mathName] =
                    declaration[mathName];
            }
        }
        records[index] = makeElement(declarations);
        elements[index] = records[index].element;
    }
    const sourceMath = (options && options.math) || Math;
    const math = {};
    for (const mathName of mathNames) {
        if (sourceMath[mathName] !== undefined) {
            math[mathName] = sourceMath[mathName];
        }
    }
    if (name === 'random') {
        const randomBases = (options && options.randomBases) ||
            [(options && options.args) ? options.args[0] : undefined];
        let randomIndex = 0;
        math.random = function () {
            randomCalls += 1;
            randomIndex += 1;
            return randomBases[randomIndex - 1];
        };
    }
    const css = options && options.css ? options.css : options && options.supports ? {
        supports(property, value) {
            assert.equal(this, css);
            supportsCalls.push([property, value]);
            return options.supports(property, value);
        }
    } : undefined;
    const context = {
        Math: math,
        Number,
        window: css ? {CSS: css} : {},
        document: {
            querySelectorAll(selector) {
                selectors.push(selector);
                return selector === allAttributesSelector ? elements : [];
            }
        },
        paste: {
            define(moduleName, dependencies, factory) {
                assert.equal(moduleName, 'paste.ui.polyfills.cssmath');
                assert.deepEqual(Array.from(dependencies), []);
                assert.equal(typeof factory, 'function');
                namespace = {};
                factory(namespace);
            }
        }
    };
    vm.runInNewContext(moduleSource, context);
    for (let index = 0; index < records.length; index += 1) {
        values[index] = records[index].value();
        writes[index] = records[index].writes;
        writeProperties[index] = records[index].writeProperties;
    }
    return {
        values,
        writes,
        writeProperties,
        selectors,
        supportsCalls,
        randomCalls,
        namespace
    };
}

function runDeclaration(name, declarationText, options) {
    const result = runPage(name, [declarationText], options);
    return {
        value: result.values[0],
        writes: result.writes[0],
        writeProperties: result.writeProperties[0],
        selectors: result.selectors,
        supportsCalls: result.supportsCalls,
        randomCalls: result.randomCalls,
        namespace: result.namespace
    };
}

function invoke(name, args, options) {
    const formatted = formatArguments(name, args);
    const property = name === 'asin' || name === 'acos' || name === 'atan' || name === 'atan2' ?
        'rotate' : 'opacity';
    const attributeText = property + ': ' + formatted.text;
    const settings = Object.assign({}, options || {}, {args});
    const result = runDeclaration(name, attributeText, settings);
    if (result.writes.length === 0) {
        return undefined;
    }
    assert.equal(result.writes.length, 1, name + ' should write exactly once');
    return parseFloat(result.value);
}

function mathFacade(math) {
    const facade = {};
    for (const name of functionNames) {
        facade[name] = function () {
            const args = Array.prototype.slice.call(arguments);
            return invoke(name, args, {math});
        };
    }
    return facade;
}

const cssmath = mathFacade(Math);
const es5Math = {};
for (const mathName of mathNames) {
    if (mathName !== 'sign') {
        es5Math[mathName] = Math[mathName];
    }
}
const es5Cssmath = mathFacade(es5Math);

test('binds declarations in one define-time sweep without exposing a control API', () => {
    const result = runDeclaration('min', 'opacity: 1, 2');
    assert.deepEqual(result.selectors, [allAttributesSelector]);
    assert.deepEqual(result.writes, ['1']);
    assert.deepEqual(Object.keys(result.namespace), []);
});

test('native support skips writes; missing or unsupported CSS.supports uses one fallback write', () => {
    const supported = runDeclaration('min', 'width: 1px, 2px', {
        supports(property, value) {
            return property === 'width' && value === 'min(1px, 2px)';
        }
    });
    assert.deepEqual(supported.supportsCalls, [['width', 'min(1px, 2px)']]);
    assert.deepEqual(supported.writes, []);

    const unsupported = runDeclaration('min', 'width: 1px, 2px', {
        supports() { return false; }
    });
    assert.deepEqual(unsupported.supportsCalls, [['width', 'min(1px, 2px)']]);
    assert.deepEqual(unsupported.writes, ['1px']);

    const absent = runDeclaration('min', 'width: 1px, 2px');
    assert.deepEqual(absent.supportsCalls, []);
    assert.deepEqual(absent.writes, ['1px']);

    const missingSupports = runDeclaration('min', 'width: 1px, 2px', {css: {}});
    assert.deepEqual(missingSupports.supportsCalls, []);
    assert.deepEqual(missingSupports.writes, ['1px']);
});

test('native support skips parsing arguments outside the fallback grammar', () => {
    const probe = 'max(10px, calc(1px + 2px))';
    const supported = runDeclaration('max', 'width: 10px, calc(1px + 2px)', {
        supports(property, value) {
            return property === 'width' && value === probe;
        }
    });
    assert.deepEqual(supported.supportsCalls, [['width', probe]]);
    assert.deepEqual(supported.writes, []);
});

test('native support is cached by property and full probe string', () => {
    const declarations = [
        'width: 1px, 2px',
        'width: 1px, 2px'
    ];
    const supported = runPage('min', declarations, {supports() { return true; }});
    assert.equal(supported.supportsCalls.length, 1);
    assert.deepEqual(supported.writes, [[], []]);

    const unsupported = runPage('min', declarations, {supports() { return false; }});
    assert.equal(unsupported.supportsCalls.length, 1);
    assert.deepEqual(unsupported.writes, [['1px'], ['1px']]);

    const supportsRound = (property, value) => property === 'opacity' && value === 'round(1, 2)';
    const oneThenTwo = runPage('round', [
        'opacity: 2',
        'opacity: 1, 2'
    ], {supports: supportsRound});
    const twoThenOne = runPage('round', [
        'opacity: 1, 2',
        'opacity: 2'
    ], {supports: supportsRound});
    assert.equal(oneThenTwo.supportsCalls.length, 2);
    assert.deepEqual(oneThenTwo.writes, [['2'], []]);
    assert.equal(twoThenOne.supportsCalls.length, 2);
    assert.deepEqual(twoThenOne.writes, [[], ['2']]);
});

test('native support cache separates identical probes by property', () => {
    // The module visits querySelectorAll results from last to first.
    const distinctProperties = runPage('min', [
        'height: 1px, 2px',
        'width: 1px, 2px'
    ], {
        supports(property) {
            return property === 'width';
        }
    });
    assert.deepEqual(distinctProperties.supportsCalls, [
        ['width', 'min(1px, 2px)'],
        ['height', 'min(1px, 2px)']
    ]);
    assert.deepEqual(distinctProperties.writeProperties, [['height'], []]);
    assert.deepEqual(distinctProperties.writes, [['1px'], []]);
});

test('several declarations on one element each write once', () => {
    // The module visits function attributes from last to first.
    const result = runPage('min', [{
        min: 'width: 1px, 2px',
        max: 'height: 1px, 2px'
    }], {supports() { return false; }});
    assert.deepEqual(result.supportsCalls, [
        ['height', 'max(1px, 2px)'],
        ['width', 'min(1px, 2px)']
    ]);
    assert.deepEqual(result.writeProperties, [['height', 'width']]);
    assert.deepEqual(result.writes, [['2px', '1px']]);
});

test('angle unit factors convert trig inputs to radians in declarations', () => {
    const expected = String(Math.sin(Math.PI / 2));
    assert.equal(runDeclaration('sin', 'opacity: 100grad').value, expected);
    assert.equal(runDeclaration('sin', 'opacity: 0.25turn').value, expected);
    assert.equal(runDeclaration('sin', 'opacity: 1.5707963267948966rad').value, expected);
    assert.equal(runDeclaration('sin', 'opacity: 0.25TURN').value, expected);
});

test('shared units are preserved, angle units are converted, and invalid declarations are untouched', () => {
    assert.equal(runDeclaration('clamp', 'width: 1px, 2px, 3px').value, '2px');
    assert.equal(runDeclaration('sin', 'opacity: 90deg').value, String(Math.sin(Math.PI / 2)));
    assert.equal(runDeclaration('asin', 'rotate: 1').value, Math.PI / 2 + 'rad');
    const atan2Result = String(Math.PI / 4) + 'rad';
    assert.equal(runDeclaration('atan2', 'rotate: 1px, 1px').value, atan2Result);
    assert.equal(runDeclaration('atan2', 'rotate: 10deg, 10deg').value, atan2Result);
    assert.equal(runDeclaration('atan2', 'rotate: -0, -1').value, String(Math.PI) + 'rad');
    assert.equal(runDeclaration('atan2', 'rotate: -0px, -1px').value, String(Math.PI) + 'rad');

    const invalid = [
        ['min', 'width: 1px, 2em'],
        ['sin', 'opacity: 1constructor'],
        ['min', 'width: 1constructor, 2constructor'],
        ['min', 'width: 10%, 20%'],
        ['max', 'background-position-x: 10%, 20%'],
        ['clamp', 'width: 10%, 20%, 30%'],
        ['max', 'width: 1px, nope'],
        ['clamp', 'width: 1px, 2px'],
        ['round', 'width: unexpected, 1px, 2px'],
        ['round', 'width: 1px'],
        ['round', 'width: up, 1px'],
        ['round', 'width: 1%'],
        ['round', 'width: down, 1%'],
        ['random', 'width: 20%, 80%'],
        ['abs', 'background-position-x: -10%'],
        ['sign', 'opacity: 10%'],
        ['progress', 'opacity: 50%, 0%, 100%'],
        ['min', 'width: 1., 2px'],
        ['min', 'width: 1.px, 2px'],
        ['min', 'opacity: +infinity, 1'],
        ['min', 'opacity: -NaN, 1'],
        ['min', 'width: infinity, 1px'],
        ['min', 'width: e, 1px'],
        ['sin', 'opacity: 1px'],
        ['sqrt', 'width: 4px'],
        ['random', 'width: 1px'],
        ['sign', 'opacity: 1bogus'],
        ['progress', 'opacity: 1bogus, 2bogus, 3bogus'],
        ['atan2', 'rotate: 1%, 1%'],
        ['atan2', 'rotate: 1bogus, 2bogus'],
        ['atan2', 'rotate: 1px, 1em'],
        ['min', '--tile-width: 10px, 20px']
    ];
    for (const declaration of invalid) {
        assert.deepEqual(runDeclaration(declaration[0], declaration[1]).writes, []);
    }

    assert.deepEqual(runDeclaration('min', 'width: 1PX, 2px').writes, ['1px']);
    assert.deepEqual(runDeclaration('sin', 'opacity: 90DEG').writes, ['1']);
    assert.equal(runDeclaration('round', 'width: UP, 1px, 2px').value, '2px');
    assert.equal(runDeclaration('min', 'opacity: E, pI').value, String(Math.E));
    assert.equal(runDeclaration('min', 'opacity: iNfInItY, 1').value, '1');
    assert.equal(runDeclaration('max', 'opacity: -InFiNiTy, -1').value, '-1');
    assert.equal(runDeclaration('sqrt', 'opacity: nAn').value, '0');

    const validUnits = [
        'px', 'cm', 'q', 'em', 'rem', 'lh', 'vw', 'svh', 'lvw', 'dvb',
        'cqw', 'cqmin', 'deg', 'turn', 'ms', 'khz', 'dpcm', 'dppx'
    ];
    for (const unit of validUnits) {
        assert.equal(runDeclaration('min', 'width: 1' + unit + ', 2' +
            unit).writes.length, 1, unit + ' should be accepted');
    }
});

test('writes go through setProperty with the lowercased property', () => {
    const declarations = [
        'cssText: 1',
        'length: 1',
        'setProperty: 1',
        'unknown-property: 1',
        'Width: 1px, 2px'
    ];

    const page = runPage('min', declarations);
    assert.deepEqual(page.writeProperties, [
        ['csstext'], ['length'], ['setproperty'], ['unknown-property'], ['width']
    ]);
    assert.deepEqual(page.writes, [['1'], ['1'], ['1'], ['1'], ['1px']]);

    const continued = runPage('min', [
        'Width: 1px, 2px',
        'width: 1bogus, 2bogus'
    ]);
    assert.deepEqual(continued.writeProperties, [['width'], []]);
    assert.deepEqual(continued.writes, [['1px'], []]);
});

test('CSS Values 4 §10.9 serializes NaN, infinities, and exponent notation', () => {
    assert.deepEqual(runDeclaration('sqrt', 'opacity: -1').writes, ['0']);
    assert.deepEqual(runDeclaration('sqrt', 'opacity: NaN').writes, ['0']);
    assert.deepEqual(runDeclaration('asin', 'rotate: 2').writes, ['0rad']);
    assert.deepEqual(runDeclaration('cos', 'opacity: 90DEG').writes, ['0']);

    const infinite = runDeclaration('exp', 'opacity: 1000');
    assert.deepEqual(infinite.writes, []);

    assert.deepEqual(runDeclaration('exp', 'opacity: 100').writes, []);
    assert.deepEqual(runDeclaration('pow', 'opacity: 10, 21').writes, []);
    assert.deepEqual(runDeclaration('sqrt', 'opacity: 1e-200').writes, ['0']);
});

test('random draws Math.random once for each unsupported element declaration', () => {
    const result = runDeclaration('random', 'width: 0px, 10px, 1px', {
        args: [0.5, 0, 10, 1]
    });
    assert.equal(result.randomCalls, 1);
    assert.deepEqual(result.writes, ['5px']);

    const page = runPage('random', [
        'width: 0px, 10px',
        'width: 0px, 10px'
    ], {randomBases: [0.2, 0.4]});
    assert.equal(page.randomCalls, 2);
    assert.deepEqual(page.writes, [['4px'], ['2px']]);
});

test('CSS Values 4 §10.2 comparison functions write numeric results', () => {
    equalNumber(cssmath.min(3, -2, 4), -2);
    equalNumber(cssmath.max(3, -2, 4), 4);
    equalNumber(cssmath.min(Infinity, NaN), NaN);
    equalNumber(cssmath.max(-Infinity, NaN), NaN);
    equalNumber(cssmath.clamp(2, 5, 4), 4);
    equalNumber(cssmath.clamp(4, 2, 1), 4);
    equalNumber(cssmath.clamp(-Infinity, -3, Infinity), -3);
    equalNumber(cssmath.clamp(NaN, 1, 2), NaN);
});

test('CSS Values 4 §10.3 round cases (WPT unit variants collapse to the same numbers)', () => {
    const inputs = [23, 18, 15, 13, -13, -18];
    const cases = [
        ['nearest', [20, 20, 20, 10, -10, -20]],
        ['down', [20, 10, 10, 10, -20, -20]],
        ['up', [30, 20, 20, 20, -10, -10]],
        ['to-zero', [20, 10, 10, 10, -10, -10]]
    ];
    for (let caseIndex = cases.length - 1; caseIndex >= 0; caseIndex -= 1) {
        for (let inputIndex = inputs.length - 1; inputIndex >= 0; inputIndex -= 1) {
            equalNumber(cssmath.round(cases[caseIndex][0], inputs[inputIndex], 10),
                cases[caseIndex][1][inputIndex]);
        }
    }
    equalNumber(cssmath.round(undefined, -15, 10), -10);
    const strategies = ['nearest', 'down', 'up', 'to-zero'];
    for (const strategy of strategies) {
        equalNumber(cssmath.round(strategy, 10, 5), 10);
        equalNumber(cssmath.round(strategy, -10, 5), -10);
    }
    equalNumber(cssmath.round(undefined, 1.5), 2);
    equalNumber(cssmath.round('up', 1.5), 2);
    equalNumber(cssmath.round('down', 1.5), 1);
    equalNumber(cssmath.round('to-zero', 1.5), 1);
    equalNumber(cssmath.round(undefined, -1.5), -1);
    equalNumber(cssmath.round('up', -1.5), -1);
    equalNumber(cssmath.round('down', -1.5), -2);
    equalNumber(cssmath.round('to-zero', -1.5), -1);
});

test('round preserves exact decimal multiples and rounds non-multiples by strategy', () => {
    assert.equal(runDeclaration('round', 'width: down, 100px, .1px').value, '100px');
    assert.equal(runDeclaration('round', 'opacity: up, -1, .2').value, '-1');
    assert.equal(runDeclaration('round', 'opacity: nearest, 1, .2').value, '1');
    assert.equal(runDeclaration('round', 'opacity: to-zero, -1, .2').value, '-1');
    assert.equal(runDeclaration('round', 'opacity: down, 1.05, .2').value, '1');
    assert.equal(runDeclaration('round', 'opacity: nearest, 1.05, .2').value, '1');
    assert.equal(runDeclaration('round', 'opacity: up, 1.05, .2').value, '1.2000000000000002');
    assert.equal(runDeclaration('round', 'opacity: to-zero, -1.05, .2').value, '-1');
});

test('CSS Values 4 §10.3.1 round argument ranges', () => {
    const nanRows = [
        [undefined, 5, 0], [undefined, Infinity, Infinity], [undefined, Infinity, -Infinity],
        [undefined, -Infinity, Infinity], [undefined, -Infinity, -Infinity],
        [undefined, Infinity, 0], [undefined, -Infinity, -0],
        [undefined, NaN, 5], [undefined, NaN, -5], [undefined, NaN, 0],
        [undefined, NaN, Infinity], [undefined, NaN, -Infinity],
        [undefined, 5, NaN], [undefined, -5, NaN], [undefined, 0, NaN],
        [undefined, Infinity, NaN], [undefined, NaN, NaN],
        ['nearest', NaN, 5], ['up', NaN, 5], ['down', NaN, 5], ['to-zero', NaN, 5]
    ];
    for (const row of nanRows) {
        equalNumber(cssmath.round(row[0], row[1], row[2]), NaN);
    }
    const strategies = ['up', 'down', 'nearest', 'to-zero'];
    for (const strategy of strategies) {
        equalNumber(cssmath.round(strategy, Infinity, 5), Infinity);
        equalNumber(cssmath.round(strategy, -Infinity, -5), -Infinity);
    }
    equalNumber(cssmath.round(undefined, 5, Infinity), 0);
    equalNumber(cssmath.round('to-zero', 5, -Infinity), 0);
    equalNumber(cssmath.round(undefined, -5, Infinity), 0);
    equalNumber(cssmath.round('to-zero', -5, -Infinity), 0);
    equalNumber(cssmath.round('up', 1, Infinity), Infinity);
    equalNumber(cssmath.round('up', 0, Infinity), 0);
    equalNumber(cssmath.round('up', -1, -Infinity), 0);
    equalNumber(cssmath.round('down', -1, Infinity), -Infinity);
    equalNumber(cssmath.round('down', 0, Infinity), 0);
    equalNumber(cssmath.round('down', 1, -Infinity), 0);
    const infiniteStepCases = [
        ['nearest', 4, 0], ['nearest', -4, 0], ['nearest', 0, 0],
        ['up', 4, Infinity], ['up', -4, 0], ['up', 0, 0],
        ['down', 4, 0], ['down', -4, -Infinity], ['down', 0, 0],
        ['to-zero', 4, 0], ['to-zero', -4, 0], ['to-zero', 0, 0]
    ];
    for (const row of infiniteStepCases) {
        equalNumber(cssmath.round(row[0], row[1], Infinity), row[2]);
        equalNumber(cssmath.round(row[0], row[1], -Infinity), row[2]);
    }
    equalNumber(cssmath.round('down', (7 - 1) / 3, 1), 2);
    equalNumber(cssmath.round('down', 0.2, 1), 0);
    equalNumber(cssmath.round('up', -0.2, 1), 0);
    equalNumber(cssmath.round('to-zero', -0.2, 1), 0);
});

test('CSS Values 4 §10.3 and §10.3.1 mod and rem sign/range cases', () => {
    const rows = [
        ['mod', 18, 5, 3], ['rem', 18, 5, 3], ['mod', -140, -90, -50],
        ['mod', -18, 5, 2], ['rem', -18, 5, -3], ['mod', 140, -90, -40],
        ['rem', 140, -90, 50], ['mod', -1, 2, 1], ['mod', 1, -2, -1],
        ['rem', -1, -2, -1], ['mod', -19, 5, 1], ['rem', -19, 5, -4],
        ['mod', 0, 2, 0], ['mod', 2, 2, 0], ['mod', -2, 2, 0],
        ['mod', 0, -2, 0], ['mod', 2, -2, 0], ['mod', -2, -2, 0],
        ['rem', -1, 1, 0], ['rem', 1, -1, 0], ['rem', -1, -1, 0]
    ];
    for (const row of rows) {
        equalNumber(cssmath[row[0]](row[1], row[2]), row[3]);
    }
    const names = ['mod', 'rem'];
    for (const name of names) {
        equalNumber(cssmath[name](0, 0), NaN);
        equalNumber(cssmath[name](Infinity, 0), NaN);
        equalNumber(cssmath[name](-Infinity, 5), NaN);
        equalNumber(cssmath[name](5, NaN), NaN);
        equalNumber(cssmath[name](5, Infinity), 5);
    }
    equalNumber(cssmath.mod(NaN, 5), NaN);
    equalNumber(cssmath.mod(5, 0), NaN);
    equalNumber(cssmath.rem(NaN, 5), NaN);
    equalNumber(cssmath.rem(Infinity, 5), NaN);
    equalNumber(cssmath.rem(5, 0), NaN);
    equalNumber(cssmath.mod(Infinity, Infinity), NaN);
    equalNumber(cssmath.mod(-Infinity, -Infinity), NaN);
    equalNumber(cssmath.mod(Infinity, -Infinity), NaN);
    equalNumber(cssmath.mod(-Infinity, Infinity), NaN);
    equalNumber(cssmath.rem(Infinity, Infinity), NaN);
    equalNumber(cssmath.rem(-Infinity, -Infinity), NaN);
    equalNumber(cssmath.rem(Infinity, -Infinity), NaN);
    equalNumber(cssmath.rem(-Infinity, Infinity), NaN);
    equalNumber(cssmath.mod(-0, Infinity), 0);
    equalNumber(cssmath.mod(0, -Infinity), NaN);
    equalNumber(cssmath.mod(-4, Infinity), NaN);
    equalNumber(cssmath.mod(4, -Infinity), NaN);
    equalNumber(cssmath.mod(4, Infinity), 4);
    equalNumber(cssmath.mod(-4, -Infinity), -4);
    equalNumber(cssmath.mod(-5, Infinity), NaN);
    equalNumber(cssmath.mod(5, -Infinity), NaN);
    equalNumber(cssmath.mod(-5, -Infinity), -5);
});

test('CSS Values 4 §10.4.1 trigonometric argument ranges', () => {
    equalNumber(cssmath.sin(Infinity), NaN);
    equalNumber(cssmath.cos(-Infinity), NaN);
    equalNumber(cssmath.tan(Infinity), NaN);
    equalNumber(cssmath.asin(2), NaN);
    equalNumber(cssmath.asin(-2), NaN);
    equalNumber(cssmath.acos(2), NaN);
    equalNumber(cssmath.acos(-2), NaN);
    equalNumber(cssmath.acos(1), 0);
    equalNumber(cssmath.atan(Infinity), Math.PI / 2);
    equalNumber(cssmath.atan(-Infinity), -Math.PI / 2);
    equalNumber(cssmath.sin(0), 0);
    equalNumber(cssmath.cos(0), 1);
    closeNumber(cssmath.sin(Math.PI / 4), Math.SQRT1_2);
    closeNumber(cssmath.cos(Math.PI / 3), 0.5);
    closeNumber(cssmath.tan(Math.PI / 4), 1);
    closeNumber(cssmath.asin(0.5), Math.PI / 6);
    closeNumber(cssmath.acos(0), Math.PI / 2);
    closeNumber(cssmath.acos(-1), Math.PI);
    closeNumber(cssmath.atan(1), Math.PI / 4);
    assert.ok(Number.isFinite(cssmath.tan(Math.PI / 2)));

    const values = [-Infinity, -1, 0, 1, Infinity];
    const expected = [
        [-3 * Math.PI / 4, -Math.PI / 2, -Math.PI / 2, -Math.PI / 2, -Math.PI / 4],
        [-Math.PI, -3 * Math.PI / 4, -Math.PI / 2, -Math.PI / 4, 0],
        [Math.PI, Math.PI, 0, 0, 0],
        [Math.PI, 3 * Math.PI / 4, Math.PI / 2, Math.PI / 4, 0],
        [3 * Math.PI / 4, Math.PI / 2, Math.PI / 2, Math.PI / 2, Math.PI / 4]
    ];
    for (let rowIndex = values.length - 1; rowIndex >= 0; rowIndex -= 1) {
        for (let columnIndex = values.length - 1; columnIndex >= 0; columnIndex -= 1) {
            const actual = cssmath.atan2(values[rowIndex], values[columnIndex]);
            if (Object.is(expected[rowIndex][columnIndex], 0)) {
                equalNumber(actual, expected[rowIndex][columnIndex]);
            } else {
                closeNumber(actual, expected[rowIndex][columnIndex]);
            }
        }
    }
    closeNumber(cssmath.tan(315 * Math.PI / 180), -1);
    closeNumber(cssmath.tan(405 * Math.PI / 180), 1);
    closeNumber(cssmath.atan2(1, -1), 3 * Math.PI / 4);
    closeNumber(cssmath.atan2(-1, 1), -Math.PI / 4);
});

test('CSS Values 4 §10.5.1 pow, sqrt, and hypot argument ranges', () => {
    const powRows = [
        [-Infinity, -3, 0], [-Infinity, -2, 0], [-Infinity, 0, 1],
        [-Infinity, 1, -Infinity], [-Infinity, 2, Infinity], [-Infinity, 3, -Infinity],
        [0, -3, Infinity], [0, -2, Infinity], [0, 0, 1],
        [0, 1, 0], [0, 2, 0], [0, 3, 0],
        [Infinity, -3, 0], [Infinity, -2, 0], [Infinity, 0, 1],
        [Infinity, 1, Infinity], [Infinity, 2, Infinity], [Infinity, 3, Infinity],
        [-2, 0.5, NaN], [-8, 1 / 3, NaN], [NaN, 0, NaN], [1, NaN, NaN]
    ];
    for (const row of powRows) {
        equalNumber(cssmath.pow(row[0], row[1]), row[2]);
    }
    const infiniteExponents = [
        [-2, Infinity, Infinity], [-1, Infinity, NaN], [-0.5, Infinity, 0],
        [0.5, Infinity, 0], [1, Infinity, NaN], [2, Infinity, Infinity],
        [-2, -Infinity, 0], [-1, -Infinity, NaN], [-0.5, -Infinity, Infinity],
        [0.5, -Infinity, Infinity], [1, -Infinity, NaN], [2, -Infinity, 0]
    ];
    for (const row of infiniteExponents) {
        equalNumber(cssmath.pow(row[0], row[1]), row[2]);
    }
    equalNumber(cssmath.pow(2, 3), 8);
    equalNumber(cssmath.sqrt(-0), 0);
    equalNumber(cssmath.sqrt(Infinity), Infinity);
    equalNumber(cssmath.sqrt(-1), NaN);
    equalNumber(cssmath.sqrt(-Infinity), NaN);
    equalNumber(cssmath.hypot(3, 4), 5);
    equalNumber(cssmath.hypot(-5), 5);
    equalNumber(cssmath.hypot(0, -0), 0);
    equalNumber(cssmath.hypot(Infinity, 5), Infinity);
    equalNumber(cssmath.hypot(NaN, 5), NaN);
    equalNumber(cssmath.hypot(Infinity, NaN), NaN);
    equalNumber(cssmath.hypot(NaN, Infinity), NaN);
    closeNumber(cssmath.hypot(1e308, 1e308), Math.SQRT2 * 1e308);
    closeNumber(cssmath.hypot(3e-200, 4e-200), 5e-200);
});

test('CSS Values 4 §10.5.1 log and exp ranges', () => {
    equalNumber(cssmath.log(1), 0);
    equalNumber(cssmath.log(1, 0.5), 0);
    equalNumber(cssmath.log(10, 10), 1);
    equalNumber(cssmath.log(2, 0), NaN);
    equalNumber(cssmath.log(2, 1), NaN);
    equalNumber(cssmath.log(5, 1), NaN);
    equalNumber(cssmath.log(2, -1), NaN);
    equalNumber(cssmath.log(2, 0.5), -1);
    equalNumber(cssmath.log(2, 2), 1);
    equalNumber(cssmath.log(-1), NaN);
    equalNumber(cssmath.log(-1, 2), NaN);
    equalNumber(cssmath.log(-0), -Infinity);
    equalNumber(cssmath.log(0, 2), -Infinity);
    equalNumber(cssmath.log(0, 0.5), -Infinity);
    equalNumber(cssmath.log(1, 2), 0);
    equalNumber(cssmath.log(Infinity), Infinity);
    equalNumber(cssmath.log(Infinity, 2), Infinity);
    equalNumber(cssmath.log(Infinity, 0.5), Infinity);
    equalNumber(cssmath.log(NaN, 1), NaN);
    equalNumber(cssmath.log(NaN, 2), NaN);
    equalNumber(cssmath.log(1, NaN), NaN);
    equalNumber(cssmath.log(2, NaN), NaN);
    equalNumber(cssmath.exp(0), 1);
    equalNumber(cssmath.exp(Infinity), Infinity);
    equalNumber(cssmath.exp(-Infinity), 0);
    equalNumber(cssmath.exp(NaN), NaN);
    closeNumber(cssmath.log(Math.E), 1);
    closeNumber(cssmath.log(100, 10), 2);
    closeNumber(cssmath.exp(cssmath.log(7)), 7);
    equalNumber(cssmath.log(cssmath.exp(1)), 1);
});

test('CSS Values 4 §10.6 sign and abs (WPT unit/type variants collapse to plain numbers)', () => {
    equalNumber(cssmath.abs(-0), 0);
    equalNumber(cssmath.abs(-3), 3);
    equalNumber(cssmath.abs(Infinity), Infinity);
    equalNumber(cssmath.abs(NaN), NaN);
    equalNumber(cssmath.sign(0), 0);
    equalNumber(cssmath.sign(-3), -1);
    equalNumber(cssmath.sign(3), 1);
    equalNumber(cssmath.sign(-Infinity), -1);
    equalNumber(cssmath.sign(Infinity), 1);
    equalNumber(cssmath.sign(NaN), NaN);
    equalNumber(cssmath.sign(1), 1);
    equalNumber(cssmath.sign(-1), -1);
    equalNumber(cssmath.abs(1), 1);
    equalNumber(cssmath.abs(-1), 1);
    equalNumber(cssmath.clamp(-1, 1 / cssmath.sign(0), 1), 1);
    equalNumber(cssmath.abs(10), 10);
    equalNumber(cssmath.abs(-10), 10);
    equalNumber(20 - cssmath.abs(-10), 10);
    equalNumber(20 - cssmath.abs(10), 10);
    equalNumber(cssmath.sign(20 - 2 * 10), 0);
    equalNumber(cssmath.sign(39 - 2 * 20), -1);
    equalNumber(10 + cssmath.abs(10), 20);
    equalNumber(cssmath.abs(cssmath.sign(1)), 1);
    equalNumber(cssmath.abs(cssmath.sign(cssmath.sign(1))), 1);
    equalNumber(cssmath.sign(cssmath.sign(cssmath.sign(1) + cssmath.sign(1))), 1);
    equalNumber(cssmath.abs(0.1 + 0.2) + 0.05, 0.35000000000000003);
    closeNumber(cssmath.sign(0.1 + 0.2) - 0.05, 0.95);
    closeNumber(cssmath.abs(0.1 + 0.2) * 2, 0.6);
    closeNumber(cssmath.abs(cssmath.sign(0.1) + 0.2) / 2, 0.6);
    closeNumber(cssmath.abs(0.1 + 0.2) * -2, -0.6);
    closeNumber(cssmath.sign(0.1 - 0.2) - 0.05, -1.05);
    closeNumber(cssmath.sign(1) + cssmath.sign(1) - 0.05, 1.95);
    equalNumber(10 - cssmath.abs(10 - cssmath.abs(-30)), -10);
    equalNumber(2 - cssmath.sign(1), 1);
    equalNumber(2 - cssmath.sign(-1), 3);
    equalNumber(2 - cssmath.sign(1 - cssmath.sign(-1)), 1);
    equalNumber(10 - cssmath.abs(20 - cssmath.sign(2 - cssmath.abs(-20))), -11);
    equalNumber(cssmath.sign(10) * 100, 100);
    equalNumber((20 + 1) * (cssmath.sign(20 - 10 - 10) + 1), 21);
    equalNumber(2.5 - cssmath.sign(41 - 2 * 20) / 2, 2);
    equalNumber(2.5 - cssmath.sign(40 - 2 * 20) / 2, 2.5);
    equalNumber(2.5 - cssmath.sign(39 - 2 * 20) / 2, 3);
    equalNumber(3 + cssmath.sign(42 - 2 * 20), 4);
    equalNumber(3 + cssmath.sign(40 - 2 * 20), 3);
    equalNumber(3 + cssmath.sign(38 - 2 * 20), 2);
    equalNumber(50 + 100 * cssmath.sign(42 - 2 * 20), 150);
    equalNumber(50 + 100 * cssmath.sign(40 - 2 * 20), 50);
    equalNumber(50 + 100 * cssmath.sign(38 - 2 * 20), -50);
});

test('CSS Values 4 §10.6 sign falls back when Math.sign is unavailable', () => {
    equalNumber(es5Cssmath.sign(0), 0);
    equalNumber(es5Cssmath.sign(-1), -1);
    equalNumber(es5Cssmath.sign(1), 1);
    equalNumber(es5Cssmath.sign(-Infinity), -1);
    equalNumber(es5Cssmath.sign(Infinity), 1);
    equalNumber(es5Cssmath.sign(NaN), NaN);
});

test('CSS Values 5 §5 progress clamps and handles equal endpoints', () => {
    const rows = [
        [1, 0, 1, 1], [100, 0, 50, 1], [-10, 0, 10, 0], [50, 10, 110, 0.4],
        [1000, 10, 110, 1], [50, 0, 100, 0.5], [100, 10, 10, 0],
        [1, 10, 10, 0], [10, 10, 10, 0],
        [NaN, 1, 1, NaN], [1, NaN, 2, NaN]
    ];
    for (const row of rows) {
        equalNumber(cssmath.progress(row[0], row[1], row[2]), row[3]);
    }
    equalNumber(cssmath.progress(-1, 0, 10), 0);
    equalNumber(cssmath.progress(11, 0, 10), 1);
});

test('CSS Values 5 §9.1.1 and §9.3 random cases use the supplied base value', () => {
    equalNumber(cssmath.random(0, 10, 20), 10);
    equalNumber(cssmath.random(0.5, 10, 20), 15);
    equalNumber(cssmath.random(0.99, 10, 20), 19.9);
    equalNumber(cssmath.random(0.75, 100, 10), 100);
    equalNumber(cssmath.random(0.5, -10, -100), -10);
    equalNumber(cssmath.random(0.25, Infinity, 10), Infinity);
    equalNumber(cssmath.random(0.99, 0, 3 * Number.MIN_VALUE, 2 * Number.MIN_VALUE), 3 * Number.MIN_VALUE);
    equalNumber(cssmath.random(0.5, 10, 9.9999, 1), 10);
    equalNumber(cssmath.random(0.5, 10, 10, 0), 10);
    equalNumber(cssmath.random(0.5, -Infinity, 100, NaN), NaN);
    equalNumber(cssmath.random(0.5, NaN, 100), NaN);
    equalNumber(cssmath.random(0.5, 10, NaN, Infinity), NaN);
    equalNumber(cssmath.random(0.5, Infinity, NaN), NaN);
    equalNumber(cssmath.random(0.5, 10, -Infinity), NaN);
    equalNumber(cssmath.random(0.5, 10, -Infinity, 1), NaN);
    equalNumber(cssmath.random(0.5, 1e308, -1e308), NaN);
    equalNumber(cssmath.random(0.5, 10, 5), 10);
    equalNumber(cssmath.random(0.5, 10, Infinity), NaN);
    equalNumber(cssmath.random(0.5, -1e308, 1e308), NaN);
    equalNumber(cssmath.random(0.5, 10, 20, Infinity), 10);
    equalNumber(cssmath.random(0.5, -Infinity, 10), -Infinity);
    equalNumber(cssmath.random(0.5, 0, 10, -Infinity), 0);
    equalNumber(cssmath.random(0.5, 10, 20, -2), 15);
    equalNumber(cssmath.random(0.5, 10, 20, 0), 15);
    equalNumber(cssmath.random(0.5, 0, 1, Number.MIN_VALUE), 0.5);
    equalNumber(cssmath.random(0.5, 1, 2, NaN), NaN);
    const belowMaximum = cssmath.random(0.99, 0, 100, 33.3);
    assert.ok(belowMaximum < 100);
    assert.ok(Math.abs(belowMaximum - 99.9) < 1e-12);
    equalNumber(cssmath.random(0.99, 0, 100, 33.333), 100);
    equalNumber(cssmath.random(0.99, 0, 100, 100 / 3), 100);
    equalNumber(cssmath.random(0.99, 0, 10, 3.3334), 10);
    equalNumber(cssmath.random(0.3, 0, 10), 3);
    equalNumber(cssmath.random(0.5, 10, 100, 10), 60);
    equalNumber(cssmath.random(0, 0, 4, 1), 0);
    equalNumber(cssmath.random(0.2, 0, 4, 1), 1);
    equalNumber(cssmath.random(0.999999, 0, 4, 1), 4);
});

test('WPT computed values use plain numbers (unit/type variants collapse to the same number)', () => {
    equalNumber(cssmath.round(undefined, 10, 10), 10);
    equalNumber(cssmath.round(undefined, 7.5, 1), 8);
    equalNumber(cssmath.round(undefined, 7.5, 5), 10);
    equalNumber(cssmath.round(undefined, 32, 5), 30);
    equalNumber(cssmath.round(undefined, 100, 16), 96);
    equalNumber(cssmath.round(undefined, 10, 6), 12);
    equalNumber(cssmath.round('up', 101, 10), 110);
    equalNumber(cssmath.round('down', 106, 10), 100);
    equalNumber(cssmath.round('to-zero', 105, 10), 100);
    equalNumber(cssmath.round('to-zero', -105, 10), -100);
    equalNumber(cssmath.round(undefined, -100, 10), -100);
    equalNumber(cssmath.round('up', -103, 10), -100);
    equalNumber(cssmath.mod(7.5, 1), 0.5);
    equalNumber(cssmath.mod(7.5, 5), 2.5);
    equalNumber(cssmath.mod(32, 5), 2);
    equalNumber(cssmath.mod(100, 16), 4);
    equalNumber(cssmath.mod(-18, 7.5), 4.5);
    equalNumber(cssmath.mod(1, 2), 1);
    equalNumber(cssmath.mod(3, 2), 1);
    equalNumber(cssmath.rem(7.5, 1), 0.5);
    equalNumber(cssmath.rem(7.5, 5), 2.5);
    equalNumber(cssmath.rem(32, 5), 2);
    equalNumber(cssmath.rem(100, 16), 4);
    equalNumber(cssmath.rem(-18, 7.5), -3);
    equalNumber(cssmath.rem(3, 2), 1);
    equalNumber(cssmath.rem(-1, 2), -1);
    equalNumber(cssmath.rem(1, -2), 1);
    equalNumber(cssmath.mod(18, 5) * 2 + cssmath.mod(17, 5), 8);
    equalNumber(cssmath.rem(cssmath.mod(18, 5), cssmath.mod(17, 5)), 1);
    equalNumber(cssmath.mod(cssmath.rem(1, 18) * -1, 5), 4);
});

test('WPT exp-log-compute numeric cases use plain numbers', () => {
    equalNumber(cssmath.log(1 + 1 + 2 / 2 - 2), 0);
    equalNumber(cssmath.log(1) + cssmath.exp(0), 1);
    equalNumber(cssmath.exp(cssmath.log(1) + cssmath.exp(0) * 2), Math.exp(2));
    equalNumber(cssmath.log(cssmath.log(1) + cssmath.exp(0) * 10), Math.log(10));
    equalNumber(
        cssmath.log(cssmath.log(1) + cssmath.exp(0) * 20, 10),
        Math.log(20) / Math.log(10)
    );
    equalNumber(
        cssmath.log(Math.E) / cssmath.log(Math.E) + cssmath.exp(0) * 2 * cssmath.log(Math.E),
        3
    );
    equalNumber(
        cssmath.log((1 + 1) / 2) / cssmath.log(Math.E) + cssmath.exp(0 * 1) * 2 * cssmath.log(Math.E),
        2
    );
    equalNumber(
        cssmath.log((3 + 1) / 2, 2) / cssmath.log(Math.E) + cssmath.exp(0 * 1) * 2 * cssmath.log(Math.E),
        3
    );
    equalNumber(
        cssmath.log((3 + 1) / 2, 2) / cssmath.log(Math.E, Math.E) +
            cssmath.exp(0 * 1) * 2 * cssmath.log(Math.E, Math.E),
        3
    );
    equalNumber(cssmath.exp(0) + 1, 2);
    equalNumber(Math.E - cssmath.exp(1), 0);
    closeNumber(cssmath.log(cssmath.exp(2)), 2);
    equalNumber(cssmath.pow(2, cssmath.pow(2, 2)) * 100, 1600);
    equalNumber(cssmath.pow(2, cssmath.sqrt(100)), 1024);
    equalNumber(cssmath.hypot(3e9, 4e9), 5e9);
    equalNumber(cssmath.hypot(10000), 10000);
    equalNumber(cssmath.sqrt(100000000) * 2, 20000);
    equalNumber(cssmath.pow(20, 4) * 3, 480000);
    equalNumber(100 - cssmath.hypot(30, 40), 50);
    equalNumber(10 - cssmath.hypot(10 - cssmath.hypot(3, 4), 12), -3);
});

test('WPT progress and deterministic random CSS examples use numeric equivalents', () => {
    equalNumber(cssmath.progress(cssmath.progress(1, 0, 1), cssmath.progress(0, 0, 1), cssmath.progress(1, 0, 1)), 1);
    equalNumber(cssmath.progress(cssmath.sign(-10) * 10, 10 - 10, 10 * cssmath.progress(1, 0, 1)), 0);
    equalNumber(cssmath.progress(100, 0, 50) * 10 + 100, 110);
    equalNumber(cssmath.progress(100, 0, cssmath.sign(50)), 1);
    equalNumber(cssmath.progress(50, 0, 100) * 10, 5);
    equalNumber(cssmath.random(0.5, 0, 300000), 150000);
    equalNumber(cssmath.random(0.5, 30, 10), 30);
});
