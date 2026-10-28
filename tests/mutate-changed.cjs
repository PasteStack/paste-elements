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

'use strict';

// Mutations run only in a temporary copy. A range runs its right-hand
// revision's own modules and suites; with no range, tracked and untracked
// working-tree sources apply. Interrupting a run stops its suite processes
// and removes the copy.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync, spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');

function git(args) {
    const result = spawnSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    if (result.status !== 0) throw new Error(result.stderr || 'git failed');
    return result.stdout;
}

const SNAPSHOT = ['modules', 'tests', 'README.md', 'VERSION'];

// Writes the snapshot paths of one revision under dest, byte for byte,
// through a single cat-file batch.
function exportRevision(revision, dest) {
    const names = git(['ls-tree', '-r', '-z', '--name-only', revision, '--', ...SNAPSHOT]).split('\0').filter(Boolean);
    if (!names.some(name => name.startsWith('modules/'))) throw new Error('No modules at ' + revision);
    const result = spawnSync('git', ['cat-file', '--batch'], {
        cwd: root, input: names.map(name => revision + ':' + name).join('\n') + '\n', maxBuffer: 1024 * 1024 * 1024
    });
    if (result.status !== 0) throw new Error(String(result.stderr) || 'git cat-file failed');
    const out = result.stdout;
    let offset = 0;
    for (const name of names) {
        const newline = out.indexOf(10, offset);
        const header = out.toString('utf8', offset, newline).split(' ');
        offset = newline + 1;
        // Submodule entries name no blob in this repository.
        if (header[1] !== 'blob') continue;
        const size = Number(header[2]);
        const file = path.join(dest, name);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, out.subarray(offset, offset + size));
        offset += size + 1;
    }
}

// Detached suites have their own process groups, so a terminal interrupt
// never reaches them; these are killed group-wide instead.
const running = new Set();

function stopSuite(child) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
}

// Ignore strings and comments: operators inside URLs, selectors and comment
// text are not executable mutations. Preserve offsets and line boundaries.
function executable(source) {
    const chars = source.split('');
    const blank = (start, end) => {
        for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
    };
    let i = 0;
    let previous = '';
    while (i < source.length) {
        const char = source[i];
        let end = i;
        if (source.startsWith('//', i)) {
            end = source.indexOf('\n', i);
            if (end === -1) end = source.length;
        } else if (source.startsWith('/*', i)) {
            end = source.indexOf('*/', i + 2);
            end = end === -1 ? source.length : end + 2;
        } else if (char === "'" || char === '"' || char === '`') {
            end = i + 1;
            while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
            end++;
            previous = 'value';
        } else if (char === '/' && (!previous || /^(?:return|throw|case|typeof|void|delete|new)$/.test(previous) ||
            '(,=:[!&|?{};+-*%<>~^'.includes(previous))) {
            end = i + 1;
            let inClass = false;
            while (end < source.length) {
                if (source[end] === '\\') { end += 2; continue; }
                if (source[end] === '[') inClass = true;
                if (source[end] === ']') inClass = false;
                if (source[end] === '/' && !inClass) { end++; break; }
                end++;
            }
            previous = 'value';
        }
        if (end > i) { blank(i, end); i = end; continue; }
        const word = /^[A-Za-z_$][\w$]*/.exec(source.slice(i));
        if (word) { previous = word[0]; i += word[0].length; continue; }
        if (!/\s/.test(char)) previous = char;
        i++;
    }
    return chars.join('');
}

function mutations(source, lines) {
    const original = source.split('\n');
    const code = executable(source).split('\n');
    const candidates = [];
    for (const line of lines) {
        const text = code[line - 1] || '';
        const replacements = [];
        for (const match of text.matchAll(/===|!==|<=|>=|(?<![<>=!])<(?![<=])|(?<![<>=!])>(?![>=])|\btrue\b|\bfalse\b|\bMath\.(min|max)\b/g)) {
            const flip = {'===': '!==', '!==': '===', '<=': '>', '>=': '<', '<': '>=', '>': '<=',
                true: 'false', false: 'true', 'Math.min': 'Math.max', 'Math.max': 'Math.min'};
            replacements.push({kind: 'replace ' + match[0], text: original[line - 1].slice(0, match.index) +
                flip[match[0]] + original[line - 1].slice(match.index + match[0].length)});
        }
        // Captured Math aliases and bracket access are common in modules.
        for (const match of original[line - 1].matchAll(/(?<![\w$])(?:Math|\$math)(?:\.(min|max)|\[['"](min|max)['"]\])/g)) {
            if (text[match.index] !== original[line - 1][match.index]) continue;
            const name = match[1] || match[2];
            const replacement = match[0].replace(name, name === 'min' ? 'max' : 'min');
            replacements.push({kind: 'swap ' + name, text: original[line - 1].slice(0, match.index) + replacement +
                original[line - 1].slice(match.index + match[0].length)});
        }
        for (const match of text.matchAll(/\breturn\b[^;]*;/g)) {
            replacements.push({kind: 'remove early return', text: original[line - 1].slice(0, match.index) + ';' +
                original[line - 1].slice(match.index + match[0].length)});
        }
        // Remove complete, single-line statements only. Syntax checking below
        // rejects declarations or control structures that cannot stand alone.
        if (/^\s*(?:return\b.*|throw\b.*|[\w$][^{}]*)\s*;\s*$/.test(text) && !/^\s*(?:var|let|const)\b/.test(text)) {
            replacements.push({kind: /^\s*return\b/.test(text) ? 'remove early return' : 'drop statement', text: ';'});
        }
        for (const replacement of replacements) {
            const changed = original.slice();
            changed[line - 1] = replacement.text;
            const mutated = changed.join('\n');
            try { new vm.Script(mutated); } catch (_) { continue; }
            if (!candidates.some(candidate => candidate.line === line && candidate.after === replacement.text.trim())) {
                candidates.push({line, kind: replacement.kind, before: original[line - 1].trim(), after: replacement.text.trim(), source: mutated});
            }
        }
    }
    return candidates;
}

function runSuite(suite, cwd, modules) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['--test', '--test-force-exit', '--test-reporter=dot', '--test-timeout=5000', suite], {
            cwd, env: {...process.env, PASTE_SOURCE_ROOT: modules},
            stdio: ['ignore', 'pipe', 'pipe'], detached: true
        });
        let stdout = '', stderr = '', timedOut = false;
        if (child.pid !== undefined) running.add(child);
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', data => { stderr += data; });
        const timeout = setTimeout(() => {
            timedOut = true;
            stopSuite(child);
        }, 10000);
        child.on('error', error => { clearTimeout(timeout); running.delete(child); resolve({error, stdout, stderr}); });
        child.on('close', (status, signal) => { clearTimeout(timeout); running.delete(child); resolve({status, signal, timedOut, stdout, stderr}); });
    });
}

async function main(range) {
    if (process.env.PASTE_MUTATION_REPORT && (path.resolve(process.env.PASTE_MUTATION_REPORT) === root || path.resolve(process.env.PASTE_MUTATION_REPORT).startsWith(root + path.sep))) {
        throw new Error('PASTE_MUTATION_REPORT must be outside the checkout');
    }
    if (range && !/^[^\s]+?\.{2,3}[^\s]+$/.test(range)) {
        throw new Error('Expected a git range such as HEAD~1..HEAD');
    }
    const revision = range ? range.split(/\.{2,3}/)[1] : null;
    const diff = git(['diff', '--no-ext-diff', '--no-renames', '--unified=0', range || 'HEAD', '--', 'modules']);
    const changed = new Map();
    let file;
    for (const line of diff.split('\n')) {
        if (line.startsWith('+++ b/')) {
            file = line.slice(6);
            if (file.endsWith('.js')) changed.set(file, new Set());
        }
        const hunk = /^@@ .* \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (hunk && changed.has(file)) {
            const start = Number(hunk[1]);
            const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
            for (let i = start; i < start + count; i += 1) changed.get(file).add(i);
        }
    }
    if (!range) {
        for (const name of git(['ls-files', '--others', '--exclude-standard', '-z', '--', 'modules']).split('\0')) {
            if (!name.endsWith('.js')) continue;
            const count = fs.readFileSync(path.join(root, name), 'utf8').split('\n').length;
            changed.set(name, new Set(Array.from({length: count}, (_, i) => i + 1)));
        }
    }
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-mutations-'));
    const report = {range: range || 'working tree vs HEAD', killed: 0, survived: [], timedOut: [], tested: 0};
    const checkpoint = () => {
        if (process.env.PASTE_MUTATION_REPORT) fs.writeFileSync(process.env.PASTE_MUTATION_REPORT, JSON.stringify(report, null, 2) + '\n');
    };
    const interrupt = signal => {
        for (const child of running) stopSuite(child);
        report.failure = 'interrupted by ' + signal;
        try { checkpoint(); } catch (_) {}
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        fs.rmSync(scratch, {recursive: true, force: true});
        process.exit(128 + os.constants.signals[signal]);
    };
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, interrupt);
    try {
        // One frozen snapshot of the sources and the suites that judge
        // them, taken from the same tree: edits to the live checkout cannot
        // change the baseline halfway through an audit, and a revision is
        // judged by its own suites and helpers.
        const snapshot = path.join(scratch, 'snapshot');
        fs.mkdirSync(snapshot);
        if (revision) exportRevision(revision, snapshot);
        else {
            for (const name of SNAPSHOT) {
                if (fs.existsSync(path.join(root, name))) fs.cpSync(path.join(root, name), path.join(snapshot, name), {recursive: true});
            }
        }
        const jobs = [...changed];
        let next = 0;
        const workers = [];
        for (let worker = 0; worker < 2; worker++) {
            const work = path.join(scratch, 'worker-' + worker);
            fs.cpSync(snapshot, work, {recursive: true});
            workers.push(work);
        }
        const work = async cwd => {
            const sourceRoot = path.join(cwd, 'modules');
            while (next < jobs.length) {
                const [name, lines] = jobs[next++];
                const dest = path.join(cwd, name);
                if (!fs.existsSync(dest)) continue;
                const original = fs.readFileSync(dest, 'utf8');
                const owner = path.basename(name, '.js');
                const suite = path.join(cwd, 'tests', owner + '.test.cjs');
                if (!fs.existsSync(suite)) throw new Error('No owning suite for ' + name);
                const baseline = await runSuite(suite, cwd, sourceRoot);
                if (baseline.status !== 0) throw new Error('Owning suite fails before mutation: ' + name + '\n' + baseline.stdout + baseline.stderr);
                for (const mutation of mutations(original, lines)) {
                    fs.writeFileSync(dest, mutation.source);
                    const result = await runSuite(suite, cwd, sourceRoot);
                    fs.writeFileSync(dest, original);
                    const entry = {file: name, line: mutation.line, mutation: mutation.kind, before: mutation.before, after: mutation.after};
                    report.tested++;
                    if (result.error || result.signal || result.timedOut) report.timedOut.push(entry);
                    else if (result.status === 0) report.survived.push(entry);
                    else report.killed++;
                    if (report.tested % 25 === 0) checkpoint();
                }
                process.stderr.write(name + ': ' + report.tested + ' mutations tested, ' + report.survived.length + ' survivors\n');
                checkpoint();
            }
        };
        const outcomes = await Promise.allSettled(workers.map(work));
        for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
        if (report.survived.length || report.timedOut.length) process.exitCode = 1;
    } catch (error) {
        report.failure = error.message;
        process.exitCode = 1;
    } finally {
        for (const signal of signals) process.removeListener(signal, interrupt);
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        fs.rmSync(scratch, {recursive: true, force: true});
    }
}

module.exports = {executable, mutations};
if (require.main === module) main(process.argv[2]).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
