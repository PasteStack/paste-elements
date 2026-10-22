'use strict';

// Browser coverage: every element module needs a scenario on every engine.
// The static gate below reads the checks' Java and counts a
// scenario(browser, engine, "<module> ...") call only when a run reaches
// it from main. It counts a call that is its own statement, the
// initializer or right-hand side of a declaration or assignment
// (`boolean ok = scenario(...)`, `failed += runGroup(...)`), or a
// `return`, inside plain, try, synchronized and labeled blocks and the
// bodies of for loops, in a method main reaches the same way, including
// `new Group(...).run()`, which reaches Group's methods. It does not count
// a call under an if, else, while, do, switch or catch, inside a lambda or
// anonymous class (`withPage(page -> runGroup(...))` is not counted:
// call the helper directly), after an if with a constant condition that
// leaves first (a return, a throw, or a break or continue whose target,
// labeled or not, encloses the call), inside a comment, string or text
// block, in a method nothing live calls, or in a for loop that never runs:
// one over `List`, `Set` or `Map.of()` (or a `Map.of()` view),
// `Arrays.asList()`, `Collections.empty...()` or an empty array literal,
// with or without explicit type arguments, or a counted for whose
// variable starts at a constant that already fails a constant bound
// (literals in any base, characters, + - * / % and declared final
// constants, the variable on either side). Any other loop counts, as do
// exits a constant cannot show, such as
// `if (Boolean.parseBoolean("true")) return;` or `System.exit(0);` before
// the call: those are beyond a static check, and the run results named by
// ELEMENTS_BROWSER_RESULTS and MARQUEE_BROWSER_RESULTS are the final check
// that every module's scenario passed on every engine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ENGINES = ['chromium', 'firefox', 'webkit'];

// Java source with every comment blanked: a commented-out scenario is not
// coverage. String literals, text blocks and character literals are kept,
// so a URL or a comment marker inside a string stays code.
function javaCode(source) {
    let out = '';
    let i = 0;
    while (i < source.length) {
        let end = i;
        if (source.startsWith('//', i)) {
            end = source.indexOf('\n', i);
            if (end === -1) end = source.length;
            out += ' '.repeat(end - i);
            i = end;
            continue;
        }
        if (source.startsWith('/*', i)) {
            end = source.indexOf('*/', i + 2);
            end = end === -1 ? source.length : end + 2;
            out += source.slice(i, end).replace(/[^\n]/g, ' ');
            i = end;
            continue;
        }
        if (source.startsWith('"""', i)) {
            end = i + 3;
            while (end < source.length && !source.startsWith('"""', end)) end += source[end] === '\\' ? 2 : 1;
            end += 3;
        } else if (source[i] === '"' || source[i] === "'") {
            end = i + 1;
            while (end < source.length && source[end] !== source[i] && source[end] !== '\n') end += source[end] === '\\' ? 2 : 1;
            end++;
        } else end = i + 1;
        out += source.slice(i, end);
        i = end;
    }
    return out;
}

// The tokens of commentless Java: words, literals with their quotes, and
// punctuation, with "->", "::", "&&" and "||" one token each.
function javaTokens(code) {
    const tokens = [];
    let i = 0;
    while (i < code.length) {
        let end = i + 1;
        let type = 'punct';
        if (/\s/.test(code[i])) {
            i += 1;
            continue;
        }
        if (code.startsWith('"""', i)) {
            end = i + 3;
            while (end < code.length && !code.startsWith('"""', end)) end += code[end] === '\\' ? 2 : 1;
            end += 3;
            type = 'text';
        } else if (code[i] === '"' || code[i] === "'") {
            while (end < code.length && code[end] !== code[i] && code[end] !== '\n') end += code[end] === '\\' ? 2 : 1;
            end += 1;
            type = code[i] === '"' ? 'string' : 'char';
        } else if (/[A-Za-z_$]/.test(code[i])) {
            while (end < code.length && /[\w$]/.test(code[end])) end += 1;
            type = 'word';
        } else if (/\d/.test(code[i])) {
            while (end < code.length && /[\w.]/.test(code[end])) end += 1;
            type = 'number';
        } else if (['->', '::', '&&', '||'].includes(code.slice(i, i + 2))) {
            end = i + 2;
        }
        tokens.push({type, text: code.slice(i, end)});
        i = end;
    }
    return tokens;
}

const CONTROL_HEADS = ['if', 'while', 'for', 'switch', 'catch', 'synchronized', 'try'];

// Whether the tokens at `k` are a statement label, "name:".
function labelAt(tokens, k) {
    return k >= 1 && tokens[k].type === 'word' && tokens[k].text !== 'default' && tokens[k + 1].text === ':'
        && [';', '{', '}'].includes(tokens[k - 1].text);
}

// What a "{" opens, from the tokens before it: a class or method body, a
// statement block, the body of a control statement, a lambda, an
// anonymous class or an array initializer.
function blockKind(tokens, match, open, parentKind) {
    const prev = tokens[open - 1];
    if (parentKind === null) return 'class';
    if (parentKind === 'array' && (prev.text === '{' || prev.text === ',')) return 'array';
    if (['->', 'else', 'do', 'try', 'finally', 'static'].includes(prev.text)) {
        return {'->': 'lambda', static: 'initializer'}[prev.text] || prev.text;
    }
    let close = open - 1;
    if (parentKind === 'class') {
        // A declaration's throws clause sits between its parameters and body.
        let k = open - 1;
        while (k > 0 && (tokens[k].type === 'word' || tokens[k].text === '.' || tokens[k].text === ',')
            && tokens[k].text !== 'throws') k -= 1;
        if (tokens[k].text === 'throws') close = k - 1;
    }
    if (tokens[close].text === ')') {
        const head = tokens[match[close] - 1];
        if (CONTROL_HEADS.includes(head.text)) return head.text;
        let k = match[close] - 1;
        while (k > 0 && (tokens[k].type === 'word' || '.<>,?'.includes(tokens[k].text)) && tokens[k].text !== 'new') k -= 1;
        if (tokens[k].text === 'new') return 'anonymous';
        if (parentKind === 'class') return tokens[match[close] - 2].text === 'record' ? 'class' : 'method';
        return 'other';
    }
    if (parentKind === 'class') return 'class';
    if ([';', '{', '}'].includes(prev.text) || labelAt(tokens, open - 2)) return 'block';
    if (['=', ',', '(', ']', 'return'].includes(prev.text)) return 'array';
    return 'other';
}

// The token structure the reachability walk reads: each bracket's
// partner, each token's innermost enclosing "{", what each "{" opens, and
// the boolean and numeric constants the source declares.
function javaModel(source) {
    const tokens = javaTokens(javaCode(source));
    const match = [];
    const parent = [];
    const kinds = [];
    const open = [];
    const braces = [];
    const constants = new Map();
    const numbers = new Map();
    tokens.forEach((token, k) => {
        parent[k] = braces.length ? braces[braces.length - 1] : -1;
        if (token.type !== 'punct') return;
        if ('({['.includes(token.text)) open.push(k);
        if (token.text === '{') {
            kinds[k] = blockKind(tokens, match, k, parent[k] < 0 ? null : kinds[parent[k]]);
            braces.push(k);
        }
        if (')}]'.includes(token.text) && open.length) {
            const start = open.pop();
            match[start] = k;
            match[k] = start;
            if (token.text === '}') braces.pop();
        }
    });
    tokens.forEach((token, k) => {
        const value = tokens[k + 3];
        if (token.text === 'boolean' && tokens.slice(Math.max(0, k - 3), k).some(before => before.text === 'final')
            && tokens[k + 2] && tokens[k + 2].text === '=' && value && ['true', 'false'].includes(value.text)
            && tokens[k + 4] && tokens[k + 4].text === ';') constants.set(tokens[k + 1].text, value.text === 'true');
        if (['int', 'long', 'short', 'byte', 'char'].includes(token.text)
            && tokens.slice(Math.max(0, k - 3), k).some(before => before.text === 'final')
            && tokens[k + 1] && tokens[k + 1].type === 'word' && tokens[k + 2] && tokens[k + 2].text === '=') {
            let end = k + 3;
            while (end < tokens.length && tokens[end].text !== ';') end += 1;
            numbers.set(tokens[k + 1].text, [k + 3, end]);
        }
    });
    return {tokens, match, parent, kinds, constants, numbers};
}

// The value of a condition built only from boolean literals,
// Boolean.TRUE/FALSE, declared constants, "!", "&&", "||" and
// parentheses; undefined for anything else.
function constantValue(model, from, to) {
    const {tokens, constants} = model;
    let k = from;
    const atom = () => {
        const token = tokens[k];
        if (!token || k >= to) return undefined;
        k += 1;
        if (token.text === '!') {
            const value = atom();
            return value === undefined ? undefined : !value;
        }
        if (token.text === '(') {
            const value = either();
            if (!tokens[k] || tokens[k].text !== ')') return undefined;
            k += 1;
            return value;
        }
        if (token.text === 'true' || token.text === 'false') return token.text === 'true';
        if (token.text === 'Boolean' && tokens[k] && tokens[k].text === '.' && ['TRUE', 'FALSE'].includes((tokens[k + 1] || {}).text)) {
            k += 2;
            return tokens[k - 1].text === 'TRUE';
        }
        return constants.has(token.text) ? constants.get(token.text) : undefined;
    };
    const both = () => {
        let value = atom();
        while (value !== undefined && k < to && tokens[k].text === '&&') {
            k += 1;
            const right = atom();
            value = right === undefined ? undefined : value && right;
        }
        return value;
    };
    const either = () => {
        let value = both();
        while (value !== undefined && k < to && tokens[k].text === '||') {
            k += 1;
            const right = both();
            value = right === undefined ? undefined : value || right;
        }
        return value;
    };
    const value = either();
    return k === to ? value : undefined;
}

// The last token of the statement that starts at `from`.
function statementEnd(model, from) {
    const {tokens, match} = model;
    if (tokens[from].text === '{') return match[from];
    let k = from;
    while (k < tokens.length && tokens[k].text !== ';') {
        if (tokens[k].type === 'punct' && '({['.includes(tokens[k].text)) k = match[k];
        k += 1;
    }
    return k;
}

// The extent [first, last] of the statement labeled at `label`.
function labeledExtent(model, label) {
    const {tokens, match} = model;
    let k = label + 2;
    if (['for', 'while', 'switch', 'synchronized'].includes(tokens[k].text)) k = match[k + 1] + 1;
    else if (tokens[k].text === 'do') return [label, statementEnd(model, match[statementEnd(model, k + 1) + 2])];
    return [label, statementEnd(model, k)];
}

// Whether a statement in [from, to], run before the statement at `at` in
// the block opened at `open`, always leaves before `at`: a return, an
// uncaught throw, or a break or continue that does not stay inside
// [open, at) — an unlabeled one that no loop or switch of its own
// catches, or a labeled one whose labeled statement holds `at` or the
// block. A jump in a lambda or anonymous class leaves nothing. `around`
// lists the blocks between the statement and the one opened at `open`.
function exits(model, from, to, around, open, at) {
    const {tokens, parent, kinds} = model;
    for (let k = from; k <= to; k += 1) {
        const word = tokens[k].text;
        if (!['return', 'throw', 'break', 'continue'].includes(word)) continue;
        const frames = [...around];
        for (let frame = parent[k]; frame > from; frame = parent[frame]) frames.push(kinds[frame]);
        if (frames.some(kind => ['lambda', 'anonymous', 'class'].includes(kind))) continue;
        if (word === 'throw' && frames.includes('try')) continue;
        if (word === 'break' || word === 'continue') {
            const name = tokens[k + 1].type === 'word' ? tokens[k + 1].text : null;
            if (name === null) {
                if (frames.some(kind => ['for', 'while', 'do', 'switch'].includes(kind))) continue;
            } else {
                let label = k - 1;
                while (label > 0 && !(tokens[label].text === name && labelAt(tokens, label)
                    && labeledExtent(model, label)[1] >= k)) label -= 1;
                if (label > open && labeledExtent(model, label)[1] < at) continue;
            }
        }
        return true;
    }
    return false;
}

// Whether an if with a constant condition, run before the statement at
// `at` in the block opened at `open` — directly, or in a plain, try or
// loop block nested there — always leaves first.
function guarded(model, open, at) {
    const {tokens, match, parent, kinds} = model;
    for (let k = open + 1; k < at; k += 1) {
        if (tokens[k].text !== 'if' || !tokens[k + 1] || tokens[k + 1].text !== '(') continue;
        if (![';', '{', '}'].includes(tokens[k - 1].text)) continue;
        const around = [];
        for (let frame = parent[k]; frame !== open; frame = parent[frame]) around.push(kinds[frame]);
        if (!around.every(kind => ['block', 'try', 'for', 'synchronized'].includes(kind))) continue;
        const close = match[k + 1];
        const value = constantValue(model, k + 2, close);
        if (value === undefined) continue;
        const thenEnd = statementEnd(model, close + 1);
        const elseStart = tokens[thenEnd + 1] && tokens[thenEnd + 1].text === 'else' ? thenEnd + 2 : -1;
        if (value && exits(model, close + 1, thenEnd, around, open, at)) return true;
        if (!value && elseStart > 0 && exits(model, elseStart, statementEnd(model, elseStart), around, open, at)) return true;
    }
    return false;
}

// The value of a constant numeric expression in tokens [from, to):
// integer and floating literals in any base, character literals,
// declared final constants, unary minus, + - * / % and parentheses;
// undefined for anything else.
function constantNumber(model, from, to, depth = 0) {
    const {tokens, numbers} = model;
    let k = from;
    const literal = token => {
        if (token.type === 'char') {
            const body = token.text.slice(1, -1);
            const escapes = {'\\n': 10, '\\t': 9, '\\r': 13, '\\0': 0, "\\'": 39, '\\"': 34, '\\\\': 92};
            return body.length === 1 ? body.charCodeAt(0) : escapes[body];
        }
        const text = token.text.replace(/_/g, '').replace(/[lLfFdD]$/, '');
        if (/^0[xX][0-9a-fA-F]+$/.test(text)) return parseInt(text.slice(2), 16);
        if (/^0[bB][01]+$/.test(text)) return parseInt(text.slice(2), 2);
        if (/^0[0-7]+$/.test(text)) return parseInt(text.slice(1), 8);
        return /^\d+(\.\d*)?([eE][+-]?\d+)?$/.test(text) ? Number(text) : undefined;
    };
    const unary = () => {
        const token = tokens[k];
        if (!token || k >= to) return undefined;
        k += 1;
        if (token.text === '-' || token.text === '+') {
            const value = unary();
            return value === undefined ? undefined : token.text === '-' ? -value : value;
        }
        if (token.text === '(') {
            const value = sum();
            if (!tokens[k] || tokens[k].text !== ')') return undefined;
            k += 1;
            return value;
        }
        if (token.type === 'number' || token.type === 'char') return literal(token);
        if (token.type === 'word' && numbers.has(token.text) && depth < 8) {
            const [start, end] = numbers.get(token.text);
            return constantNumber(model, start, end, depth + 1);
        }
        return undefined;
    };
    const product = () => {
        let value = unary();
        while (value !== undefined && k < to && '*/%'.includes(tokens[k].text) && tokens[k].type === 'punct') {
            const operator = tokens[k].text;
            k += 1;
            const right = unary();
            if (right === undefined || (operator !== '*' && right === 0)) return undefined;
            value = operator === '*' ? value * right : operator === '/' ? Math.trunc(value / right) : value % right;
        }
        return value;
    };
    const sum = () => {
        let value = product();
        while (value !== undefined && k < to && ['+', '-'].includes(tokens[k].text)) {
            const operator = tokens[k].text;
            k += 1;
            const right = product();
            value = right === undefined ? undefined : operator === '+' ? value + right : value - right;
        }
        return value;
    };
    const value = sum();
    return k === to ? value : undefined;
}

// A for loop that never runs its body: an enhanced for over an empty
// List, Set or Map.of() (or a view of it), Arrays.asList(),
// Collections.empty...() or an empty array literal, or a counted for
// whose variable starts at a constant that already fails a constant
// bound, the variable on either side of the comparison.
function emptyLoop(model, start, close) {
    const {tokens, match} = model;
    const top = [];
    for (let k = start + 1; k < close; k += 1) {
        if (tokens[k].type === 'punct' && '([{'.includes(tokens[k].text)) {
            k = match[k];
        } else if (tokens[k].text === ':' || tokens[k].text === ';') {
            top.push(k);
        }
    }
    if (top.length === 1 && tokens[top[0]].text === ':') {
        const iterated = tokens.slice(top[0] + 1, close).map(token => token.text).join('')
            .replace(/\.<[^()]*?>/g, '.').replace(/^java\.util\./, '');
        return /^(List|Set|Map)\.of\(\)(\.(keySet|values|entrySet)\(\))?$/.test(iterated)
            || /^Collections\.empty\w*\(\)(\.(keySet|values|entrySet)\(\))?$/.test(iterated)
            || /^Arrays\.asList\(\)$/.test(iterated)
            || /^new\w[\w.<>]*(\[\])+\{\}$/.test(iterated) || /^new\w[\w.<>]*\[0\](\[\])*$/.test(iterated);
    }
    if (top.length !== 2) return false;
    // The variable and its start: the first top-level "name = value" of
    // the initializer, after any type.
    let equals = -1;
    for (let k = start + 1; k < top[0] && equals < 0; k += 1) {
        if (tokens[k].type === 'punct' && '([{'.includes(tokens[k].text)) k = match[k];
        else if (tokens[k].text === '=' && tokens[k + 1].text !== '=') equals = k;
    }
    if (equals < 0 || tokens[equals - 1].type !== 'word') return false;
    const name = tokens[equals - 1].text;
    let valueEnd = equals + 1;
    while (valueEnd < top[0] && tokens[valueEnd].text !== ',') {
        if (tokens[valueEnd].type === 'punct' && '([{'.includes(tokens[valueEnd].text)) valueEnd = match[valueEnd];
        valueEnd += 1;
    }
    const from = constantNumber(model, equals + 1, valueEnd);
    // The bound: one comparison with the variable alone on one side.
    const conditionStart = top[0] + 1;
    const conditionEnd = top[1];
    let operator = -1;
    for (let k = conditionStart; k < conditionEnd && operator < 0; k += 1) {
        if (tokens[k].type === 'punct' && '([{'.includes(tokens[k].text)) k = match[k];
        else if (['<', '>'].includes(tokens[k].text) || (['=', '!'].includes(tokens[k].text) && tokens[k + 1].text === '=')) operator = k;
    }
    if (from === undefined || operator < 0) return false;
    const width = tokens[operator + 1].text === '=' ? 2 : 1;
    const symbol = tokens[operator].text + (width === 2 ? '=' : '');
    const leftIsName = operator - conditionStart === 1 && tokens[conditionStart].text === name;
    const rightIsName = conditionEnd - (operator + width) === 1 && tokens[conditionEnd - 1].text === name;
    if (leftIsName === rightIsName) return false;
    const bound = leftIsName ? constantNumber(model, operator + width, conditionEnd) : constantNumber(model, conditionStart, operator);
    if (bound === undefined) return false;
    const [left, right] = leftIsName ? [from, bound] : [bound, from];
    const holds = {'<': left < right, '<=': left <= right, '>': left > right, '>=': left >= right, '==': left === right, '!=': left !== right}[symbol];
    return holds === false;
}

// The first token of the statement a call at token `at` belongs to when
// the statement always evaluates the call, or -1. The call may be
// qualified (`a.b.call(...)`, `new X(...).call(...)`), a constructor
// (`new X(...)`), the initializer or right-hand side of a declaration or
// assignment, or returned.
function statementStart(model, at) {
    const {tokens, match} = model;
    let k = at;
    while (k >= 2 && tokens[k - 1].text === '.') {
        if (tokens[k - 2].type === 'word') {
            k -= 2;
        } else if (tokens[k - 2].text === ')' && tokens[match[k - 2] - 2] && tokens[match[k - 2] - 2].text === 'new'
            && tokens[match[k - 2] - 1].type === 'word') {
            k = match[k - 2] - 2;
        } else {
            return -1;
        }
    }
    if (tokens[k - 1] && tokens[k - 1].text === 'new') k -= 1;
    const prev = tokens[k - 1];
    if (prev && prev.text === 'return') return k - 1;
    if (!prev || prev.text !== '=') return k;
    let j = k - 1;
    const operator = tokens[j - 1];
    if (!operator || ['=', '!', '<', '>'].includes(operator.text)) return -1;
    if ('+-*/%&|^'.includes(operator.text)) j -= 1;
    const target = j;
    while (j > 0 && (['word', 'number'].includes(tokens[j - 1].type) || '.<>[],?'.includes(tokens[j - 1].text))) j -= 1;
    return j === target ? -1 : j;
}

// The method body a call at token `at` is unconditionally reached in, or
// -1. The statement holding the call must be one statementStart accepts,
// and every block between it and the method body must be a plain, try,
// synchronized or labeled block or the body of a for loop that runs, with
// no constant-guarded exit before it. An if, else, while, do, switch,
// catch, lambda or anonymous class on the way makes the call conditional.
function reachingMethod(model, at) {
    const {tokens, match, parent, kinds} = model;
    let k = statementStart(model, at);
    if (k < 0) return -1;
    while (k > 0) {
        const prev = tokens[k - 1];
        if (prev.text === ':' && k >= 3 && tokens[k - 2].type === 'word' && tokens[k - 2].text !== 'default'
            && [';', '{', '}'].includes(tokens[k - 3].text)) {
            k -= 2;
            continue;
        }
        if (prev.text === ')') {
            const start = match[k - 1];
            if (tokens[start - 1].text !== 'for' || emptyLoop(model, start, k - 1)) return -1;
            k = start - 1;
            continue;
        }
        if (![';', '{', '}'].includes(prev.text)) return -1;
        const open = parent[k];
        if (open < 0 || guarded(model, open, k)) return -1;
        const kind = kinds[open];
        if (kind === 'method') return open;
        if (kind === 'block') {
            k = open;
        } else if (['try', 'for', 'synchronized'].includes(kind)) {
            const head = tokens[open - 1].text === ')' ? match[open - 1] - 1 : open - 1;
            if (kind === 'for' && emptyLoop(model, head + 1, open - 1)) return -1;
            k = head;
        } else {
            return -1;
        }
    }
    return -1;
}

// The name a class, record, enum or interface body opened at `open` is
// declared with.
function className(model, open) {
    const {tokens} = model;
    let k = open - 1;
    while (k > 0 && ![';', '{', '}'].includes(tokens[k - 1].text)) k -= 1;
    for (; k < open; k += 1) {
        if (['class', 'record', 'enum', 'interface'].includes(tokens[k].text)) return tokens[k + 1].text;
    }
    return '';
}

// The titles of scenario(browser, engine, "...") calls reached from main:
// a method is live when main is, or when a live method reaches a
// statement calling it by name, or as Class.method through a new
// Class(...).method(...) call.
function reachedScenarios(source) {
    const model = javaModel(source);
    const {tokens, match, parent, kinds} = model;
    const declared = new Map();
    kinds.forEach((kind, open) => {
        if (kind !== 'method') return;
        let close = open - 1;
        while (tokens[close].text !== ')') close -= 1;
        let frame = parent[open];
        while (frame >= 0 && kinds[frame] !== 'class') frame = parent[frame];
        declared.set(open, {name: tokens[match[close] - 1].text, owner: frame < 0 ? '' : className(model, frame)});
    });
    const calls = [];
    tokens.forEach((token, k) => {
        if (token.type !== 'word' || !tokens[k + 1] || tokens[k + 1].text !== '(') return;
        const method = reachingMethod(model, k);
        if (method < 0) return;
        const made = tokens[k - 1] && tokens[k - 1].text === '.' && tokens[k - 2].text === ')'
            && tokens[match[k - 2] - 2] && tokens[match[k - 2] - 2].text === 'new';
        const callee = made ? tokens[match[k - 2] - 1].text + '.' + token.text : token.text;
        calls.push({k, name: token.text, callee, caller: declared.get(method)});
    });
    const live = new Set(['main']);
    const isLive = method => live.has(method.name) || live.has(method.owner + '.' + method.name);
    let grew = true;
    while (grew) {
        grew = false;
        calls.forEach(call => {
            if (isLive(call.caller) && !live.has(call.callee)) {
                live.add(call.callee);
                grew = true;
            }
        });
    }
    return calls
        .filter(call => call.name === 'scenario' && isLive(call.caller))
        .map(call => tokens.slice(call.k + 1, call.k + 7))
        .filter(args => args.map(arg => arg.text).slice(0, 5).join(' ') === '( browser , engine ,' && args[5].type === 'string')
        .map(args => args[5].text.slice(1, -1));
}

// Modules with no scenario the checks' code reaches.
function uncovered(names, elements, marquee) {
    const scenarios = reachedScenarios(elements);
    return names.filter(name => name === 'marquee'
        ? reachedScenarios(marquee).length === 0
        : !scenarios.some(title => title.startsWith(name + ' ')));
}

// Modules, per engine, with no passed scenario in a run's results: a
// declared scenario the runner never reaches is not coverage either.
function unexecuted(names, elementsResults, marqueeResults) {
    const missing = [];
    for (const engine of ENGINES) {
        const passed = results => results.filter(result => result.browser === engine && result.passed === true);
        const elements = passed(elementsResults).map(result => String(result.name));
        for (const name of names) {
            const ran = name === 'marquee'
                ? passed(marqueeResults).length > 0
                : elements.some(title => title.startsWith(name + ' '));
            if (!ran) missing.push(engine + ' ' + name);
        }
    }
    return missing;
}

const elements = fs.readFileSync(path.join(__dirname, 'ElementsBrowserChecks.java'), 'utf8');
const marquee = fs.readFileSync(path.join(__dirname, 'MarqueeBrowserChecks.java'), 'utf8');
const names = fs.readdirSync(path.join(root, 'modules'), {withFileTypes: true})
    .filter(entry => entry.isDirectory() && entry.name !== 'utilities' && entry.name !== 'io-reply-fragment-envelope')
    .map(entry => entry.name)
    .filter(name => fs.readdirSync(path.join(root, 'modules', name)).some(file => file.endsWith('.js')));

test('every element module has an executable browser scenario', () => {
    assert.deepEqual(uncovered(names, elements, marquee), [], 'element modules missing browser scenarios');
});

test('coverage rejects a new element and a removed scenario', () => {
    assert.deepEqual(uncovered(['new-element'], elements, marquee), ['new-element']);
    const broken = elements.replaceAll('scenario(browser, engine, "scrollspy ', 'unused(browser, engine, "scrollspy ');
    assert.deepEqual(uncovered(['scrollspy'], broken, marquee), ['scrollspy']);
    assert.deepEqual(uncovered(['marquee'], elements, ''), ['marquee']);
});

// A checks class whose main runs `body`, with `members` beside it.
const checks = (body, members = '') =>
    'class C {\n' + members + '\npublic static void main(String[] args) throws Exception {\n' + body + '\n}\n}';
const declared = 'scenario(browser, engine, "scrollspy moves", null, (page, evidence) -> {});';

test('coverage rejects commented-out scenarios and keeps string contents', () => {
    assert.deepEqual(uncovered(['scrollspy'], checks('// ' + declared), ''), ['scrollspy']);
    assert.deepEqual(uncovered(['scrollspy'], checks('/*\n' + declared + '\n*/'), ''), ['scrollspy']);
    assert.deepEqual(uncovered(['marquee'], '', checks('/* scenario(browser, engine, "x") */')), ['marquee']);
    assert.deepEqual(uncovered(['scrollspy'], checks('String u = "http://a/*"; ' + declared + ' // */'), ''), []);
    assert.deepEqual(uncovered(['scrollspy'], checks('String b = """\n  // not a comment\n  """; char c = \'"\'; ' + declared), ''), []);
    const code = javaCode('a /* x\ny */ b // z\n"//" \'/\'');
    assert.equal(code.length, 'a /* x\ny */ b // z\n"//" \'/\''.length);
    assert.equal(code.replace(/\s+/g, ' '), 'a b "//" \'/\'');
});

test('coverage counts only scenarios a run reaches', () => {
    // Reached: straight-line code, plain and try blocks, loops over
    // nonempty literals, and methods main calls through such statements.
    for (const body of [
        declared,
        '{ ' + declared + ' }',
        'try { ' + declared + ' } catch (Exception e) {}',
        'for (String m : List.of("a")) { ' + declared + ' }',
        'for (int i = 0; i < 2; i += 1) ' + declared,
        'if (args.length > 9) return; ' + declared,
        'if (false) return; ' + declared,
        'boolean ok = ' + declared,
        'engines: for (String engine : List.of("chromium")) { ' + declared + ' }',
        'synchronized (C.class) { ' + declared + ' }',
        'blk: { ' + declared + ' }',
        'for (String e : List.of("a")) { inner: for (String f : List.of("b")) { if (true) break inner; } ' + declared + ' }',
        'outer: for (String e : List.of("a")) { for (String f : List.of("b")) { if (true) continue; } ' + declared + ' }',
        'for (int i = 0; i < 1; ) { ' + declared + ' break; }',
        'for (var i = 0; 0 <= i; i += 1) { ' + declared + ' break; }',
        "for (char c = 'a'; c <= 'a'; c += 1) " + declared,
        'for (String m : List.of("a")) ' + declared
    ]) assert.deepEqual(uncovered(['scrollspy'], checks(body), ''), [], body);
    const group = 'static int run(Browser browser, String engine) { ' + declared + ' return 0; }';
    for (const body of [
        'run(null, null);',
        'int failed = run(null, null);',
        'int failed = 0; failed += run(null, null);',
        'for (String engine : engines(args)) { try (Browser browser = launch(engine)) { run(browser, engine); } }'
    ]) assert.deepEqual(uncovered(['scrollspy'], checks(body, group), ''), [], body);
    const instance = 'static final class Group { Group(Browser b, String e) {} void go() { ' + declared + ' } }';
    assert.deepEqual(uncovered(['scrollspy'], checks('new Group(null, null).go();', instance), ''), []);
    // Not reached: guarded by an if, else, loop condition, switch, catch,
    // lambda or anonymous class, an empty loop, after a constant-guarded
    // exit, inside a text block, or in a method nothing live calls.
    for (const [body, members] of [
        ['if (Boolean.FALSE) ' + declared],
        ['if (false) { ' + declared + ' }'],
        ['if (true) ' + declared],
        ['if (OFF) ' + declared, 'static final boolean OFF = false;'],
        ['if (args.length > 0) ' + declared],
        ['if (true) {} else ' + declared],
        ['if (true) {} else { ' + declared + ' }'],
        ['while (args.length > 0) { ' + declared + ' break; }'],
        ['do ' + declared + ' while (false);'],
        ['switch (args.length) { case 0: ' + declared + ' }'],
        ['switch (args.length) { case 0 -> ' + declared + ' default -> {} }'],
        ['try {} catch (Exception e) { ' + declared + ' }'],
        ['Runnable later = () -> ' + declared.slice(0, -1) + ';'],
        ['Runnable later = () -> { ' + declared + ' };'],
        ['new Object() { void later() { ' + declared + ' } };'],
        ['for (Object m : List.of()) ' + declared],
        ['for (String m : new String[0]) { ' + declared + ' }'],
        ['for (int i = 0; i < 0; i += 1) ' + declared],
        ['for (int i = 3; i <= 2; i += 1) { ' + declared + ' }'],
        ['for (var i = 0; i < 0; i += 1) ' + declared],
        ['for (int i = 0; 0 > i; i += 1) ' + declared],
        ['for (int i = 0; i < 0; ) ' + declared],
        ["for (char c = 'a'; c < 'a'; c += 1) " + declared],
        ['for (Integer i = 0, j = 1; i < 0x0; i += 1) ' + declared],
        ['for (int i = 0; i < ZERO + 0; i += 1) ' + declared, 'static final int ZERO = 0;'],
        ['for (String m : List.<String>of()) ' + declared],
        ['for (String m : java.util.Arrays.asList()) ' + declared],
        ['for (String m : java.util.Map.<String, String>of().keySet()) ' + declared],
        ['outer: for (String e : List.of("a")) { for (String f : List.of("b")) { if (true) continue outer; } ' + declared + ' }'],
        ['outer: for (String e : List.of("a")) { for (String f : List.of("b")) { if (true) break outer; } ' + declared + ' }'],
        ['out: { if (true) break out; ' + declared + ' }'],
        ['out: { if (true) return; } ' + declared],
        ['withPage(page -> run(null, null));', 'static void run(Browser browser, String engine) { ' + declared + ' }'],
        ['while (it.hasNext()) { ' + declared + ' it.next(); }'],
        ['boolean ok = args.length > 0 && ' + declared],
        ['new Other(null, null).go();', 'static final class Group { void go() { ' + declared + ' } } static final class Other { void go() {} }'],
        ['case0: ' + 'switch (args.length) { default: ' + declared + ' }'],
        ['if (Boolean.TRUE) return; ' + declared],
        ['if (!OFF) { throw new IllegalStateException(); } ' + declared, 'static final boolean OFF = false;'],
        ['{ if (true) return; } ' + declared],
        ['String later = """\n' + declared + '\n""";'],
        ['', 'static void unused(Browser browser, String engine) { ' + declared + ' }'],
        ['if (false) run(null, null);', 'static void run(Browser browser, String engine) { ' + declared + ' }'],
        ['run(null, null);', 'static void run(Browser browser, String engine) { if (true) return; ' + declared + ' }']
    ]) assert.deepEqual(uncovered(['scrollspy'], checks(body, members), ''), ['scrollspy'], body + ' ' + (members || ''));
    // The real checks with their one scrollspy scenario made unreachable.
    const call = 'scenario(browser, engine, "scrollspy ';
    assert.deepEqual(uncovered(['scrollspy'], elements.replaceAll(call, 'if (Boolean.FALSE) ' + call), marquee), ['scrollspy']);
    const inTextBlock = elements.replaceAll(call, 'unused(browser, engine, "scrollspy ')
        .replace('public final class ElementsBrowserChecks {',
            'public final class ElementsBrowserChecks {\n    static final String KEPT = """\n        ' + call + 'moves")\n        """;');
    assert.deepEqual(uncovered(['scrollspy'], inTextBlock, marquee), ['scrollspy']);
    assert.deepEqual(uncovered(['marquee'], elements, marquee.replaceAll('scenario(browser, engine, "', 'if (false) scenario(browser, engine, "')), ['marquee']);
});

test('run results reject a scenario that never ran or failed on an engine', () => {
    const ran = ENGINES.flatMap(engine => [
        {browser: engine, name: 'scrollspy moves', passed: true},
        {browser: engine, name: 'marquee loops', passed: true}
    ]);
    assert.deepEqual(unexecuted(['scrollspy', 'marquee'], ran, ran), []);
    const failed = ran.map(result => result.browser === 'webkit' ? {...result, passed: false} : result);
    assert.deepEqual(unexecuted(['scrollspy'], failed, ran), ['webkit scrollspy']);
    assert.deepEqual(unexecuted(['marquee'], ran, []), ENGINES.map(engine => engine + ' marquee'));
    assert.deepEqual(unexecuted(['stickynav'], ran, ran), ENGINES.map(engine => engine + ' stickynav'));
});

// The complete check names the results of the runs it just made; every
// element module must have passed a scenario on every engine there. Both
// files are required once either is named.
const elementsResults = process.env.ELEMENTS_BROWSER_RESULTS;
const marqueeResults = process.env.MARQUEE_BROWSER_RESULTS;
if (elementsResults || marqueeResults) {
    test('every element module passed a browser scenario on every engine in the named run', () => {
        assert.ok(elementsResults && marqueeResults, 'name both ELEMENTS_BROWSER_RESULTS and MARQUEE_BROWSER_RESULTS');
        const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(unexecuted(names, read(elementsResults), read(marqueeResults)), [],
            'element modules with no passed scenario in the run');
    });
}
