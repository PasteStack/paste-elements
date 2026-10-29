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
const fs = require('fs');
const path = require('path');

// Every module source opens with the lint directives and globals
// declaration — the header is part of the file's contract, not an
// optional preamble. These gates scan the checkout's own module tree
// unconditionally: they never follow PASTE_SOURCE_ROOT, which points at
// a consumer's built output where headers are not the source.
//
// Each gate is a function of the source text alone, so the negative
// fixtures at the end of this file can feed it every spelling it must
// catch — dotted, bracketed with either quote, split across lines,
// reached through call/apply — and prove that it fires. A gate that only
// ever sees clean sources passes whether or not it works.
const modulesRoot = path.join(__dirname, '../modules');

function moduleFiles(dir) {
    const out = [];
    fs.readdirSync(dir, {withFileTypes: true}).forEach(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            moduleFiles(full).forEach(found => out.push(found));
        } else if (entry.name.endsWith('.js')) {
            out.push(full);
        }
    });
    return out;
}

function moduleSources() {
    return moduleFiles(modulesRoot).map(file => ({
        rel: path.relative(modulesRoot, file).replace(/\\/g, '/'),
        source: fs.readFileSync(file, 'utf8')
    }));
}

function lineAt(source, offset) {
    return source.slice(0, offset).split('\n').length;
}

function matchLines(source, pattern) {
    const lines = [];
    const global = new RegExp(pattern.source, pattern.flags.indexOf('g') === -1 ? pattern.flags + 'g' : pattern.flags);
    let match = global.exec(source);
    while (match) {
        lines.push(lineAt(source, match.index));
        match = global.exec(source);
    }
    return lines;
}

// A /** ... */ documentation block may show an example; it is blanked
// before a scan that exempts documentation. Its newlines are kept, so
// line numbers stay true.
function blankJsDoc(source) {
    return source.replace(/\/\*\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '));
}

// A member name spelled either way: `.name` or `['name']` / `["name"]`,
// with any whitespace JavaScript allows around the tokens.
function member(names) {
    return '(?:\\.\\s*(?:' + names + ')\\b|\\[\\s*([\'"])(?:' + names + ')\\1\\s*\\])';
}

// An optional `.call` / `.apply` / `['call']` / `['apply']` hop, then
// the opening parenthesis of a call. The quote group is numbered by the
// caller's position, so it is spelled without a backreference.
const CALL_HOP = '(?:\\s*(?:\\.\\s*(?:call|apply)\\b|\\[\\s*[\'"](?:call|apply)[\'"]\\s*\\]))?\\s*\\(';

const ITERATION_NAMES =
    'forEach|map|filter|reduce|reduceRight|some|every|flatMap|find|findIndex|findLast|findLastIndex|sort';
const ITERATION_PATTERN = new RegExp(member(ITERATION_NAMES) + CALL_HOP, 'g');
// Array.from with a mapping callback: the call's argument list carries a
// second top-level argument.
const ARRAY_FROM_CALL = new RegExp('\\bArray\\s*' + member('from') + CALL_HOP, 'g');

const HAS_OWN_CALL = new RegExp(member('hasOwnProperty') + CALL_HOP, 'g');
const HAS_OWN_DOTTED_CHAIN = /Object\s*\.\s*prototype\s*\.\s*hasOwnProperty/g;

// A console member reached any way code can reach it: console.log,
// console . warn (, console['error'], window['console']. A comment
// that ends a sentence on the word ("written to the console.") is not a
// member access and is not matched.
const CONSOLE_PATTERN = new RegExp([
    '\\bconsole\\.[A-Za-z_$]',
    '\\bconsole\\s*\\.\\s*[A-Za-z_$][\\w$]*\\s*[(\\[=;,)]',
    '\\bconsole\\s*\\[',
    '\\[\\s*([\'"])console\\1\\s*\\]'
].join('|'), 'g');

// Comments and string literals blanked to spaces, newlines kept, so a
// scan sees only code tokens at their true lines. A '/' where an operand
// may begin opens a regular expression literal, which is skipped whole so
// a quote inside it never opens a string.
function blankCommentsAndStrings(source) {
    const out = source.split('');
    const blank = (from, to) => {
        for (let at = from; at < to; at += 1) {
            if (out[at] !== '\n') {
                out[at] = ' ';
            }
        }
    };
    let index = 0;
    let previous = '';
    while (index < source.length) {
        const char = source[index];
        const next = source[index + 1];
        let end = -1;
        if (char === '/' && next === '/') {
            end = source.indexOf('\n', index);
            end = end === -1 ? source.length : end;
            blank(index, end);
        } else if (char === '/' && next === '*') {
            end = source.indexOf('*/', index + 2);
            end = end === -1 ? source.length : end + 2;
            blank(index, end);
        } else if (char === '"' || char === "'") {
            end = index + 1;
            while (end < source.length && source[end] !== char && source[end] !== '\n') {
                end += source[end] === '\\' ? 2 : 1;
            }
            end += 1;
            blank(index + 1, end - 1);
            previous = char;
        } else if (char === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.indexOf(previous) !== -1)) {
            let inClass = false;
            end = index + 1;
            while (end < source.length && source[end] !== '\n' && (source[end] !== '/' || inClass)) {
                if (source[end] === '\\') {
                    end += 1;
                } else if (source[end] === '[') {
                    inClass = true;
                } else if (source[end] === ']') {
                    inClass = false;
                }
                end += 1;
            }
            end += 1;
            blank(index + 1, end - 1);
            previous = '/';
        }
        if (end !== -1) {
            index = end;
        } else {
            if (!(/\s/).test(char)) {
                previous = (/[\w$]/).test(char) ? 'a' : char;
            }
            index += 1;
        }
    }
    return out.join('');
}

// Any console identifier in code: an alias (var c = window.console),
// a bare reference passed along, or a member access. Comments are
// covered by CONSOLE_PATTERN, which flags commented-out member uses but
// lets a sentence name the console.
const CONSOLE_IDENTIFIER = /\bconsole\b/g;

const EVAL_PATTERN = /\beval\s*\(|\[\s*(['"])eval\1\s*\]/g;

// Line 1 is the only /*jslint*/ directive and line 2 the only /*globals*/
// one: a later directive comment re-enables a tolerance part-way through
// the file, where no reader of the header would see it.
const LATER_DIRECTIVE = /\/\*\s*(?:jslint|jshint|globals?|properties|members)\b/g;

// An optional /*! ... */ license block may sit before the required
// header comments; every gate sees the source as it is from that point.
function stripLicenseBlock(source) {
    const match = source.match(/^\/\*![\s\S]*?\*\/\r?\n?/);
    return match ? source.slice(match[0].length).replace(/^\s+/, '') : source;
}

function headerOffenses(source) {
    source = stripLicenseBlock(source);
    const lines = source.split(/\r?\n/);
    const offenses = [];
    if (!(/^\/\*jslint\b/).test(lines[0] || '')) {
        offenses.push('no jslint directive on line 1');
        return offenses;
    }
    if (!(/^\/\*globals\b/).test(lines[1] || '')) {
        offenses.push('no globals directive on line 2');
    }
    return offenses;
}

// The line of every Array.from call given a second argument: from the
// call's opening parenthesis, a comma at the call's own depth.
function arrayFromMapLines(source) {
    const code = blankCommentsAndStrings(source);
    const lines = [];
    const global = new RegExp(ARRAY_FROM_CALL.source, 'g');
    // The call is found in the source (a bracketed 'from' is a string),
    // its arguments are walked in the blanked code at the same offsets,
    // and a call spelled inside a comment or string is no call.
    let match = global.exec(source);
    while (match) {
        if (code[match.index] !== source[match.index]) {
            match = global.exec(source);
            continue;
        }
        let depth = 1;
        let at = match.index + match[0].length;
        while (at < code.length && depth > 0) {
            const char = code[at];
            if (char === '(' || char === '[' || char === '{') {
                depth += 1;
            } else if (char === ')' || char === ']' || char === '}') {
                depth -= 1;
            } else if (char === ',' && depth === 1) {
                lines.push(lineAt(source, match.index));
                break;
            }
            at += 1;
        }
        match = global.exec(source);
    }
    return lines;
}

function iterationUses(source) {
    const lines = matchLines(source, ITERATION_PATTERN).concat(arrayFromMapLines(source));
    return lines.filter((line, index) => lines.indexOf(line) === index).sort((a, b) => a - b);
}

function directiveOffenses(source) {
    source = stripLicenseBlock(source);
    const offenses = [];
    const header = source.split(/\r?\n/)[0] || '';
    // The vars tolerance would silence the one-var-statement rule the
    // house style requires — no header may declare it.
    if ((/\bvars\b/).test(header)) {
        offenses.push('vars tolerance in the header');
    }
    const firstTwo = source.split('\n').slice(0, 2).join('\n').length;
    const global = new RegExp(LATER_DIRECTIVE.source, 'g');
    let match = global.exec(source);
    while (match) {
        const line = lineAt(source, match.index);
        const isHeaderJslint = match.index === 0;
        const isHeaderGlobals = line === 2 && match.index < firstTwo && (/globals?/).test(match[0]);
        if (!isHeaderJslint && !isHeaderGlobals) {
            offenses.push('directive comment after the header at line ' + line + ': ' + match[0]);
        }
        match = global.exec(source);
    }
    return offenses;
}

function hasOwnPropertyLines(source) {
    const lines = matchLines(source, HAS_OWN_CALL).concat(matchLines(source, HAS_OWN_DOTTED_CHAIN));
    return lines.filter((line, index) => lines.indexOf(line) === index).sort((a, b) => a - b);
}

function consoleLines(source) {
    const lines = matchLines(blankJsDoc(source), CONSOLE_PATTERN)
        .concat(matchLines(blankCommentsAndStrings(source), CONSOLE_IDENTIFIER));
    return lines.filter((line, index) => lines.indexOf(line) === index).sort((a, b) => a - b);
}

function evalOffenses(source) {
    source = stripLicenseBlock(source);
    const offenses = [];
    const header = source.split(/\r?\n/)[0] || '';
    if (header.indexOf('browser:true') === -1) {
        offenses.push('browser:true missing');
    }
    // JSLint's option is spelled `evil`; `eval` is checked too so neither
    // spelling can slip a permission into a header.
    if ((/\b(?:evil|eval)\b/).test(header)) {
        offenses.push('eval permission in header');
    }
    matchLines(blankJsDoc(source), EVAL_PATTERN).forEach(line => {
        offenses.push('eval call at line ' + line);
    });
    return offenses;
}

test('every module source opens with jslint directives and a globals line', () => {
    const sources = moduleSources();
    assert.ok(sources.length >= 10, 'the scan found almost no modules — the check is not exercising the tree');
    const missing = [];
    sources.forEach(({rel, source}) => {
        headerOffenses(source).forEach(offense => missing.push(rel + ': ' + offense));
    });
    assert.deepEqual(missing, [], 'module sources missing their required headers');
});

test('shipped module sources carry no array callback iteration', () => {
    // The performance convention is countdown-while traversal — or a
    // forward index where order matters — never an array callback
    // method: no forEach/map/filter/reduce/reduceRight/some/every/
    // flatMap/find/findIndex/findLast/findLastIndex/sort call, dotted or
    // bracketed, direct or through call/apply, and no Array.from with a
    // mapping callback.
    // paste.util['each'] stays repository-native where its early-exit
    // semantics earn the callback. No file is exempt.
    const offenders = [];
    moduleSources().forEach(({rel, source}) => {
        iterationUses(source).forEach(line => {
            offenders.push(rel + ':' + line + ': callback-iteration call site');
        });
    });
    assert.deepEqual(offenders, [], 'module sources reintroduced callback iteration');
});

test('every shipped module is JSLint-clean under its own header', () => {
    // The vendored classic JSLint — edition 2014-04-21, published in npm
    // package jslint@0.8.1 as lib/jslint-2014-04-21.js and carried here
    // with a .cjs name so a consumer's asset scan never serves the
    // validator as a site script — lints each module with no options
    // beyond the file's own /*jslint*/ and /*globals*/ directives. Every
    // warning fails the gate, including 'Stopping.', since a stop means
    // part of the file went unchecked. There are no pinned counts and no
    // tolerated reasons: a tolerance a file needs belongs in its header,
    // where a reader can see it — never in a later directive comment.
    const lintContext = {};
    require('vm').createContext(lintContext);
    require('vm').runInContext(
        fs.readFileSync(path.join(__dirname, 'vendor/jslint-2014-04-21.cjs'), 'utf8'),
        lintContext);
    const JSLINT = lintContext.JSLINT;
    const offenders = [];
    moduleSources().forEach(({rel, source}) => {
        directiveOffenses(source).forEach(offense => offenders.push(rel + ': ' + offense));
        JSLINT(source, {maxerr: 10000});
        (JSLINT.errors || []).forEach(error => {
            if (error) {
                offenders.push(rel + ':' + error.line + ':' + error.character + ' — ' + error.reason);
            }
        });
    });
    assert.deepEqual(offenders, [], 'module sources with JSLint warnings');
});

test('shipped module sources never call hasOwnProperty at a use site', () => {
    // Own-key checks on module-owned maps use null-prototype dictionaries
    // (Object['create'](null)) or a builtin captured once as a factory
    // var ($hasOwn = Object['prototype']['hasOwnProperty']); calling it
    // through the chain at a use site — dotted or bracketed — walks
    // Object -> prototype -> hasOwnProperty on every lookup, the hot-path
    // cost the house style rules out, and calling it on the object itself
    // trusts a member the object may shadow.
    const offenders = [];
    moduleSources().forEach(({rel, source}) => {
        hasOwnPropertyLines(source).forEach(line => offenders.push(rel + ':' + line));
    });
    assert.deepEqual(offenders, [], 'hasOwnProperty call sites in shipped modules');
});

test('shipped module sources carry no console use outside JSDoc', () => {
    // Shipped code never logs — not even in a commented-out line, not
    // through a bracketed window['console'], and not through an alias:
    // code names no console identifier at all. Only a /** ... */
    // documentation block may show console (an example in
    // documentation). A comment that names the console without reaching
    // for a member is not a use.
    const offenders = [];
    moduleSources().forEach(({rel, source}) => {
        consoleLines(source).forEach(line => offenders.push(rel + ':' + line));
    });
    assert.deepEqual(offenders, [], 'console use outside JSDoc in shipped modules');
});

test('every jslint header declares browser, and no source permits or calls eval', () => {
    const offenders = [];
    moduleSources().forEach(({rel, source}) => {
        evalOffenses(source).forEach(offense => offenders.push(rel + ': ' + offense));
    });
    assert.deepEqual(offenders, [], 'module headers with unsafe or missing flags, or eval calls');
});

// Negative fixtures: each spelling a gate must catch, fed to that gate
// directly. Every row here would pass a gate that matched only the
// dotted spelling, so each proves the gate actually fires on it.

const HEADER = '/*jslint browser:true sub:true */\n/*globals paste */\n';

test('the iteration gate fires on every spelling and spares the permitted ones', () => {
    const caught = [
        'a.map(f);',
        'a . forEach (f);',
        'a\n    .filter(f);',
        "a['map'](f);",
        'a["reduce"](f, 0);',
        "a [ 'some' ] (f);",
        "a['every']\n(f);",
        'Array.prototype.forEach.call(list, f);',
        'a.reduceRight(f, 0);',
        'a.find(f);',
        'a.findIndex(f);',
        'a.findLast(f);',
        "a['findLastIndex'](f);",
        "a['sort'](f);",
        'a.sort();',
        'Array.prototype.sort.call(list, f);',
        'Array.from(list, f);',
        "Array['from'](list, function (v) { return v; });",
        'Array.from(\n    list,\n    f\n);',
        "Array['prototype']['map']['call'](list, f);",
        "Array['prototype'][\"filter\"].apply(list, [f]);",
        'a.flatMap(f);'
    ];
    caught.forEach(spelling => {
        assert.equal(iterationUses(HEADER + spelling).length, 1, 'the iteration gate missed: ' + spelling);
    });
    const spared = [
        "paste.util['each'](list, f);",
        "image.style.filter = 'none';",
        "var mapper = a['map'];",
        'a.mapping(f);',
        "a['maps'](f);",
        'a.map',
        'a.sorted(f);',
        'a.finder(f);',
        'Array.from(list);',
        'Array.from(make(a, b));',
        "Array.from(list); // Array.from(list, f)",
        "var s = 'Array.from(list, f)';"
    ];
    spared.forEach(spelling => {
        assert.equal(iterationUses(HEADER + spelling).length, 0, 'the iteration gate misfired on: ' + spelling);
    });
});

test('the directive gate fires on vars in the header and on any later directive comment', () => {
    assert.deepEqual(directiveOffenses(HEADER + 'var a = 1;\n'), []);
    assert.ok(directiveOffenses('/*jslint browser:true vars:true */\n/*globals paste */\n').length > 0,
        'vars in the header was not caught');
    [
        '/*jslint vars:true */\nvar a = 1;\n',
        '/* jslint vars:true */\n',
        '    /*jslint evil:true */\n',
        '/*globals window */\n',
        '/*global console */\n',
        '/*properties foo */\n',
        '/*jshint evil:true */\n'
    ].forEach(later => {
        assert.ok(directiveOffenses(HEADER + 'var a = 1;\n' + later).length > 0,
            'a later directive was not caught: ' + JSON.stringify(later));
    });
});

test('the hasOwnProperty gate fires on every call-site spelling and spares the captured factory var', () => {
    [
        'Object.prototype.hasOwnProperty.call(o, k);',
        'Object.prototype.hasOwnProperty',
        "Object['prototype']['hasOwnProperty']['call'](o, k);",
        "Object['prototype'][\"hasOwnProperty\"].call(o, k);",
        "({})['hasOwnProperty']\n    ['call'](o, k);",
        'o.hasOwnProperty(k);',
        "o['hasOwnProperty'](k);",
        "o [ 'hasOwnProperty' ] .apply(o, [k]);"
    ].forEach(spelling => {
        assert.ok(hasOwnPropertyLines(HEADER + spelling).length > 0,
            'the hasOwnProperty gate missed: ' + spelling);
    });
    [
        "var $hasOwn = Object['prototype']['hasOwnProperty'];",
        "$hasOwn['call'](o, k);",
        'var hasOwnPropertyCount = 0;'
    ].forEach(spelling => {
        assert.deepEqual(hasOwnPropertyLines(HEADER + spelling), [],
            'the hasOwnProperty gate misfired on: ' + spelling);
    });
});

test('the console gate fires on every spelling outside JSDoc', () => {
    [
        'console.log(1);',
        "window['console']['log'](1);",
        'window["console"].warn(1);',
        "var c = window [ 'console' ];",
        'console [\'error\'](1);',
        'console . warn (1);',
        '// console.log(state);',
        '/* console.log(state); */',
        'var c = window.console; c.log(1);',
        "var c = window\n    .console;",
        'var c = console;',
        'report(console);',
        "var re = /'/, c = console;"
    ].forEach(spelling => {
        assert.ok(consoleLines(HEADER + spelling).length > 0, 'the console gate missed: ' + spelling);
    });
    [
        '/** Example: console.log(paste.ui.x); */',
        '// Nothing is written to the console.',
        '// is written to the console. Nothing else is.',
        "throw new TypeError('nothing reaches the console');",
        "var consoleless = 1, re = /console/;"
    ].forEach(spelling => {
        assert.deepEqual(consoleLines(HEADER + spelling), [], 'the console gate misfired on: ' + spelling);
    });
});

test('the eval gate fires on the evil option, an eval header flag and an eval call', () => {
    assert.deepEqual(evalOffenses(HEADER + 'var a = 1;'), []);
    assert.ok(evalOffenses('/*jslint browser:true sub:true evil:true */\n').length > 0,
        'the evil option was not caught');
    assert.ok(evalOffenses('/*jslint browser:true eval:true */\n').length > 0,
        'an eval header flag was not caught');
    assert.ok(evalOffenses('/*jslint sub:true */\n').length > 0, 'a header without browser:true was not caught');
    [
        "eval('a + b');",
        "eval ('a');",
        "window['eval']('a');",
        'window["eval"]("a");'
    ].forEach(spelling => {
        assert.ok(evalOffenses(HEADER + spelling).length > 0, 'the eval gate missed: ' + spelling);
    });
    [
        'retrieval(x);',
        'evaluate(x);',
        '/** eval(x) is never used */'
    ].forEach(spelling => {
        assert.deepEqual(evalOffenses(HEADER + spelling), [], 'the eval gate misfired on: ' + spelling);
    });
});

test('one source carrying every bypass spelling trips every gate', () => {
    const source = [
        '/*jslint browser:true sub:true evil:true */',
        '/*globals paste */',
        "var y = [1, 2]['map'](function (v) { return v; }), z = Object['prototype']['hasOwnProperty']['call']({}, 'a');",
        '/*jslint vars:true */',
        'var a = 1;',
        "var b = window['console']['log'];",
        "eval('a + b');"
    ].join('\n');
    assert.deepEqual(headerOffenses(source), []);
    assert.deepEqual(iterationUses(source), [3]);
    assert.deepEqual(hasOwnPropertyLines(source), [3]);
    assert.deepEqual(consoleLines(source), [6]);
    assert.ok(directiveOffenses(source).some(offense => (/line 4/).test(offense)),
        'the later /*jslint vars*/ was not caught');
    const evalFound = evalOffenses(source);
    assert.ok(evalFound.indexOf('eval permission in header') !== -1, 'evil:true was not caught');
    assert.ok(evalFound.indexOf('eval call at line 7') !== -1, 'the eval call was not caught');
});
