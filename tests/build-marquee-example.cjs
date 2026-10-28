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

// Builds the standalone marquee example and records its identity:
//
//   PASTE_CORE_JS=/path/to/paste/src/js node tests/build-marquee-example.cjs [paste-assetgraph]
//
// target/marquee-example/build-identity.json records the SHA-256 of the
// source tree the build read (the example page and config, the marquee
// and paste.ui.utilities modules, and the paste core files) and of each
// file the example serves. The browser runner verifies a served example
// against that record before any browser launches:
//
//   PASTE_CORE_JS=/path/to/paste/src/js node tests/build-marquee-example.cjs --verify <baseUrl> <recordPath>
//
// A build older than its sources, a build output changed after the
// build, or a server answering with other bytes fails the verification.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'target/marquee-example');
const identityFile = path.join(output, 'build-identity.json');
// The files the example page loads, by served path.
const servedFiles = {'': 'index.html', 'example.js': 'example.js', 'example.css': 'example.css'};
// The core `paste` modules are a separate release; this repository must not
// encode where a machine keeps them.
const coreJs = process.env.PASTE_CORE_JS;
if (!coreJs) {
    throw new Error('Set PASTE_CORE_JS to the src/js directory of a paste release (or checkout) before building the example');
}
if (!fs.existsSync(path.join(coreJs, 'paste.js'))) {
    throw new Error('PASTE_CORE_JS does not contain paste.js: ' + coreJs);
}

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

function walk(dir, files) {
    fs.readdirSync(dir, {withFileTypes: true}).forEach(function (entry) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walk(child, files);
        } else if (entry.isFile()) {
            files.push(child);
        }
    });
    return files;
}

// One digest over every source the build reads, each file named by its
// place in its own tree (never by a machine's absolute path), so the same
// sources hash the same on any checkout.
function sourceTreeHash() {
    const entries = [];
    const add = function (label, base, files) {
        files.forEach(function (file) {
            entries.push(label + ':' + path.relative(base, file).split(path.sep).join('/') +
                '\0' + sha256(fs.readFileSync(file)));
        });
    };
    add('repo', root, [path.join(root, 'examples/marquee.html'), path.join(root, 'examples/marquee.conf')]);
    add('repo', root, walk(path.join(root, 'modules/marquee'), []));
    add('repo', root, walk(path.join(root, 'modules/utilities'), []));
    add('core', path.resolve(coreJs), walk(path.resolve(coreJs), []));
    entries.sort();
    return sha256(entries.join('\n'));
}

function outputDigests() {
    const digests = {};
    Object.keys(servedFiles).forEach(function (served) {
        const file = path.join(output, servedFiles[served]);
        digests[servedFiles[served]] = fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
    });
    return digests;
}

function build(binary) {
    const runConfig = path.join(root, 'target/marquee-example.conf');
    fs.mkdirSync(path.dirname(runConfig), {recursive: true});
    fs.writeFileSync(
        runConfig,
        // The marquee's own dependencies resolve from paste core and from this
        // repository's paste.ui.utilities modules.
        fs.readFileSync(path.join(root, 'examples/marquee.conf'), 'utf8') +
            'include-paths = ["' + coreJs + '", "' + path.join(root, 'modules/utilities') + '"]\n'
    );
    // The tree is hashed before the compiler reads it: a source changed
    // during the build leaves a record that no longer matches.
    const tree = sourceTreeHash();
    fs.rmSync(identityFile, {force: true});
    const run = spawnSync(binary, ['build', '--config', path.relative(root, runConfig)], {cwd: root, stdio: 'inherit'});
    if (run.error) throw run.error;
    if (run.status !== 0) process.exit(run.status || 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    const visited = new Set();
    const scripts = [];
    const content = function (key) {
        const asset = manifest.assets[key];
        if (!asset) throw new Error('Missing example asset: ' + key);
        return fs.readFileSync(path.join(output, asset.output.replace(/^\//, '')), 'utf8');
    };
    const visit = function (key) {
        if (visited.has(key)) return;
        visited.add(key);
        const asset = manifest.assets[key];
        if (!asset) throw new Error('Missing example dependency: ' + key);
        for (const dependency of asset.dependencies) {
            visit('js/' + dependency.replaceAll('.', '/') + '.js');
        }
        scripts.push(content(key));
    };
    visit('js/paste/ui/marquee.js');
    fs.writeFileSync(path.join(output, 'example.css'), content('css/marquee.css'));
    fs.writeFileSync(path.join(output, 'example.js'), scripts.join('\n;\n') + '\n;paste.require(["paste.ui.marquee"], function (module, marquee) {});\n');
    fs.copyFileSync(path.join(root, 'examples/marquee.html'), path.join(output, 'index.html'));
    fs.writeFileSync(identityFile, JSON.stringify({
        sourceTree: tree,
        outputs: outputDigests()
    }, null, 2) + '\n');
    process.stdout.write('Standalone example built at ' + path.join(output, 'index.html') + '\n');
}

function fetchBytes(url) {
    return new Promise(function (resolve, reject) {
        const request = http.get(url, function (response) {
            const chunks = [];
            response.on('data', function (chunk) { chunks.push(chunk); });
            response.on('end', function () {
                resolve(response.statusCode === 200 ? Buffer.concat(chunks) : null);
            });
        });
        request.on('error', reject);
        request.setTimeout(5000, function () {
            request.destroy(new Error('timed out: ' + url));
        });
    });
}

async function verify(baseUrl, recordPath) {
    const failures = [];
    const record = {baseUrl: baseUrl, checks: []};
    try {
        const base = new URL(baseUrl);
        if (base.pathname.slice(-1) !== '/') {
            base.pathname += '/';
        }
        const host = base.hostname.replace(/^\[|\]$/g, '');
        if (base.protocol !== 'http:' || (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1')) {
            throw new Error('the example URL is not loopback http: ' + baseUrl);
        }
        if (!fs.existsSync(identityFile)) {
            throw new Error('no build identity at target/marquee-example — build the example first');
        }
        const built = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        record.sourceTree = sourceTreeHash();
        record.builtSourceTree = built.sourceTree;
        if (record.sourceTree !== built.sourceTree) {
            failures.push('the built example is stale: its sources changed after the build — rebuild it');
        }
        const local = outputDigests();
        for (const served of Object.keys(servedFiles)) {
            const name = servedFiles[served];
            const bytes = await fetchBytes(new URL(served, base));
            const check = {
                file: name,
                builtDigest: built.outputs[name],
                localDigest: local[name],
                servedDigest: bytes ? sha256(bytes) : null
            };
            check.ok = check.builtDigest !== null && check.builtDigest !== undefined &&
                check.localDigest === check.builtDigest && check.servedDigest === check.builtDigest;
            record.checks.push(check);
            if (!check.ok) {
                failures.push(name + ' is not the recorded build (built=' + check.builtDigest +
                    ', local=' + check.localDigest + ', served=' + check.servedDigest + ')');
            }
        }
    } catch (error) {
        failures.push(error.message);
    }
    record.ok = failures.length === 0;
    record.failures = failures;
    fs.mkdirSync(path.dirname(path.resolve(recordPath)), {recursive: true});
    fs.writeFileSync(path.resolve(recordPath), JSON.stringify(record, null, 2) + '\n');
    if (record.ok) {
        process.stdout.write('marquee example identity verified\n');
    } else {
        failures.forEach(function (message) {
            process.stderr.write('marquee example identity failed: ' + message + '\n');
        });
        process.exitCode = 1;
    }
}

if (process.argv[2] === '--verify') {
    verify(process.argv[3], process.argv[4]);
} else {
    build(process.argv[2] || process.env.PASTE_ASSETGRAPH_BIN || 'paste-assetgraph');
}
