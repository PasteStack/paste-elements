'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {executable, mutations} = require('./mutate-changed.cjs');

test('mutation selection ignores strings, comments and regular expressions', () => {
    const source = `// true === false\nvar text = 'a <= b';\nvar pattern = /true\\/false[<>]/g;\nfunction match() { return /a>=b/.test(text); }\nif (left === right) run();`;
    const code = executable(source);
    assert.equal(code.split('\n').length, source.split('\n').length);
    assert.equal(code.length, source.length);
    assert.equal(code.match(/===|<=|>=|true|false/g)?.join(','), '===');
    const candidates = mutations(source, new Set([5]));
    assert.ok(candidates.some(c => c.kind === 'replace ==='));
    assert.ok(candidates.every(c => c.line === 5));
    assert.ok(candidates.every(c => c.source.split('\n').slice(0, 4).join('\n') === source.split('\n').slice(0, 4).join('\n')));
});

test('executable changed lines produce each supported mutation and valid syntax', () => {
    const source = [
        'var $math = Math, min = $math["min"];',
        'function run(value) {',
        ' if (value <= 0) { return false; }',
        ' value += 1;',
        ' return min(value, 5);',
        '}'
    ].join('\n');
    const candidates = mutations(source, new Set([1, 3, 4, 5]));
    for (const kind of ['swap min', 'replace <=', 'replace false', 'remove early return', 'drop statement']) {
        assert.ok(candidates.some(c => c.kind === kind), 'missing ' + kind);
    }
    for (const candidate of candidates) assert.doesNotThrow(() => new vm.Script(candidate.source));
    const baseline = {};
    vm.runInNewContext(source, baseline);
    assert.deepEqual([baseline.run(-1), baseline.run(1), baseline.run(9)], [false, 2, 5]);
    // These input/output checks actually distinguish executable mutations.
    const survivors = candidates.filter(candidate => {
        const context = {};
        vm.runInNewContext(candidate.source, context);
        return JSON.stringify([-1, 0, 1, 9].map(value => context.run(value))) === '[false,false,2,5]';
    });
    assert.deepEqual(survivors, []);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const hasGit = spawnSync('git', ['--version']).status === 0;
// The fixture repository sees no user or system git configuration, and the
// tool's own suites must not run as children of this test run.
const isolated = {...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1'};
delete isolated.NODE_TEST_CONTEXT;

// A throwaway repository holding a copy of this tool, plus a scratch
// directory the tool's copies land in.
function fixtureRepository(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-mutate-fixture-'));
    const temp = path.join(dir, '.tmp');
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const git = (...args) => {
        const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
            '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=' + os.devNull, ...args], {cwd: dir, env: isolated, encoding: 'utf8'});
        assert.equal(result.status, 0, result.stderr);
    };
    const write = (name, text) => {
        fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
        fs.writeFileSync(path.join(dir, name), text);
    };
    const tool = (args, extra) => spawn(process.execPath, [path.join(dir, 'tests', 'mutate-changed.cjs'), ...args],
        {cwd: dir, env: {...isolated, TMPDIR: temp, ...extra}, stdio: ['ignore', 'pipe', 'pipe']});
    fs.mkdirSync(temp);
    write('.gitignore', '.tmp/\ntests/mutate-changed.cjs\n');
    write('tests/mutate-changed.cjs', fs.readFileSync(path.join(__dirname, 'mutate-changed.cjs'), 'utf8'));
    git('init', '-q');
    return {dir, temp, git, write, tool};
}

function finished(child) {
    return new Promise(resolve => {
        let stdout = '';
        child.stdout.on('data', data => { stdout += data; });
        child.stderr.on('data', () => {});
        child.on('close', (code, signal) => resolve({code, signal, stdout}));
    });
}

const suiteFor = (yes, no) => `'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gate = require('../modules/gate/gate.js');
test('gate', () => { assert.equal(gate(${yes}), true); assert.equal(gate(${no}), false); });
`;

test('a range is judged by its right-hand revision\'s own suites', {skip: !hasGit && 'git is not installed'}, async t => {
    const repo = fixtureRepository(t);
    repo.write('modules/gate/gate.js', 'module.exports = function (value) {\n    return value > 1;\n};\n');
    repo.write('tests/gate.test.cjs', suiteFor(2, 1));
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'one');
    repo.write('modules/gate/gate.js', 'module.exports = function (value) {\n    return value > 2;\n};\n');
    repo.write('tests/gate.test.cjs', suiteFor(3, 2));
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'two');
    // The working tree's suite expects the first revision's behaviour.
    repo.write('tests/gate.test.cjs', suiteFor(2, 1));
    const result = await finished(repo.tool(['HEAD~1..HEAD']));
    const report = JSON.parse(result.stdout);
    assert.equal(report.failure, undefined, report.failure);
    assert.ok(report.tested > 0 && report.killed === report.tested, JSON.stringify(report));
    assert.equal(result.code, 0);
    assert.deepEqual(fs.readdirSync(repo.temp), []);
});

test('an interrupt stops the running suite and removes the copy', {skip: !hasGit && 'git is not installed'}, async t => {
    const repo = fixtureRepository(t);
    const marker = path.join(repo.dir, 'suite.pid');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'empty');
    repo.write('modules/gate/gate.js', 'module.exports = function (value) {\n    return value > 1;\n};\n');
    repo.write('tests/gate.test.cjs', `require('node:fs').writeFileSync(process.env.SUITE_MARKER, String(process.pid));\nfor (;;) {}\n`);
    const child = repo.tool([], {SUITE_MARKER: marker});
    const exit = finished(child);
    let pid;
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch (_) {} });
    for (let attempt = 0; attempt < 200 && !pid; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 25));
        if (fs.existsSync(marker)) pid = Number(fs.readFileSync(marker, 'utf8')) || undefined;
    }
    assert.ok(pid, 'the owning suite never started');
    child.kill('SIGINT');
    const result = await exit;
    assert.equal(result.code, 130);
    assert.match(JSON.parse(result.stdout).failure, /interrupted by SIGINT/);
    let alive = true;
    for (let attempt = 0; attempt < 40 && alive; attempt++) {
        try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 25)); } catch (_) { alive = false; }
    }
    assert.equal(alive, false, 'the suite process outlived the interrupt');
    assert.deepEqual(fs.readdirSync(repo.temp), []);
});
