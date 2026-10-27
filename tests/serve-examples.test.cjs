'use strict';

// The fixture host's route dictionaries are keyed by request-path
// segments — untrusted strings. A name that resolves through
// Object.prototype ('constructor', 'toString', '__proto__',
// 'hasOwnProperty') must answer 404 like any other undeclared route,
// never dereference an inherited member — and the host must keep
// serving declared routes afterwards. A request target the URL parser
// rejects answers 400 without stopping the host, a non-loopback Host
// header is refused, the identity response reports no filesystem
// location or process detail and digests every script the pages declare,
// and only the exact declared spelling of a path is served: an alias the
// filesystem or a lenient parse would fold onto a declared file answers
// 404.
//
// The fixture serves real core files, so this suite requires
// PASTE_CORE_JS. Without it the suite fails — locally and in CI alike —
// the same way the event parity suite does; it never skips.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const {spawn, execFile} = require('node:child_process');

const pasteCore = process.env.PASTE_CORE_JS;
const serverPath = path.join(__dirname, 'serve-examples.cjs');

function requireCore() {
    assert.ok(pasteCore,
        'PASTE_CORE_JS is not set — name the src/js directory of a paste release or checkout');
    assert.ok(fs.existsSync(path.join(pasteCore, 'paste.js')),
        'PASTE_CORE_JS does not contain paste.js: ' + pasteCore);
}

function fetch(port, requestPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            {host: '127.0.0.1', port: port, path: requestPath, headers: headers || {}},
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({
                    status: res.statusCode,
                    body: Buffer.concat(chunks).toString('utf8')
                }));
            });
        req.on('error', reject);
        req.setTimeout(5000, () => req.destroy(new Error('fixture request timed out')));
    });
}

async function status(port, requestPath, headers) {
    return (await fetch(port, requestPath, headers)).status;
}

// Writes a request line verbatim — http.get validates and normalizes
// paths, so a target the URL parser rejects can only be sent raw.
function rawStatus(port, requestText) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let reply = '';
        socket.setTimeout(5000, () => socket.destroy(new Error('raw fixture request timed out')));
        socket.on('connect', () => socket.write(requestText));
        socket.on('data', (chunk) => {
            reply += chunk;
            const match = /^HTTP\/1\.[01] (\d{3})/.exec(reply);
            if (match) {
                socket.destroy();
                resolve(Number(match[1]));
            }
        });
        socket.on('error', reject);
        socket.on('close', () => reject(new Error('connection closed without a status line: ' + reply)));
    });
}

// The fixture listens on port 0 and the system picks a free port; the
// startup line names the port actually bound, so parallel runs and a
// busy machine never collide on a guessed number.
async function startFixture(nonce) {
    const env = {...process.env, PASTE_CORE_JS: pasteCore};
    delete env.FIXTURE_NONCE;
    if (nonce) {
        env.FIXTURE_NONCE = nonce;
    }
    const server = spawn(process.execPath, [serverPath, '0'], {
        env: env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverOutput = '';
    server.stdout.on('data', (chunk) => { serverOutput += chunk; });
    server.stderr.on('data', (chunk) => { serverOutput += chunk; });
    let port;
    try {
        port = await new Promise((resolve, reject) => {
            const deadline = setTimeout(
                () => reject(new Error('fixture host did not start: ' + serverOutput)), 8000);
            server.stdout.on('data', () => {
                const bound = /fixture host: http:\/\/127\.0\.0\.1:(\d+)\//.exec(serverOutput);
                if (bound) {
                    clearTimeout(deadline);
                    resolve(Number(bound[1]));
                }
            });
            server.on('exit', (code) =>
                reject(new Error('fixture host exited ' + code + ': ' + serverOutput)));
        });
    } catch (error) {
        server.kill();
        throw error;
    }
    return {port, server};
}

test('prototype-keyed route segments answer 404 and the host survives', async () => {
    requireCore();
    const {port, server} = await startFixture();
    try {
        const hostile = ['constructor', 'toString', '__proto__', 'hasOwnProperty'];
        for (const key of hostile) {
            assert.equal(
                await status(port, '/generated/sequence/' + key + '/t0/frame-0.png'),
                404, '/generated/sequence/' + key + '/… resolved an inherited member');
            assert.equal(
                await status(port, '/generated/img/' + key + '/r0.png'),
                404, '/generated/img/' + key + '/… resolved an inherited member');
        }
        // The hostile reads crashed nothing: declared routes still answer.
        assert.equal(
            await status(port, '/examples/index.html'), 200,
            'a declared page no longer serves — the hostile requests damaged the host');
        assert.equal(
            await status(port, '/generated/sequence/catalog-press/t0/frame-0.png'), 200,
            'a declared sequence frame no longer serves');
        assert.equal(
            await status(port, '/generated/img/avatar/r0.png'), 200,
            'a declared image variant no longer serves');
        // Only the routes the example pages reference exist.
        for (const undeclared of ['/data/january.csv', '/generated/manifest/avatar.json',
            '/generated/sequence/catalog-press/manifest.json']) {
            assert.equal(await status(port, undeclared), 404, undeclared + ' is served');
        }
    } finally {
        server.kill();
    }
});

test('an unparseable request target answers 400 and the host keeps serving', async () => {
    requireCore();
    const {port, server} = await startFixture();
    try {
        const code = await rawStatus(port, 'GET //[ HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
        assert.equal(code, 400, 'GET //[ did not answer 400');
        assert.equal(
            await status(port, '/generated/img/avatar/r0.png'), 200,
            'a declared route stopped serving after the malformed request');
        // A request the HTTP parser itself rejects never reaches the
        // route handler; the clientError path answers it instead.
        const garbage = await rawStatus(port, 'NOT A REQUEST\r\n\r\n');
        assert.equal(garbage, 400, 'a malformed request line did not answer 400');
        assert.equal(
            await status(port, '/examples/index.html'), 200,
            'a declared route stopped serving after the parser-level error');
    } finally {
        server.kill();
    }
});

test('the identity response is loopback-only and reports no local paths or process ids', async () => {
    requireCore();
    const {port, server} = await startFixture();
    try {
        assert.equal(
            await status(port, '/fixture-identity', {host: 'rebound.example:' + port}), 421,
            'a non-loopback Host header was answered');
        assert.equal(
            await status(port, '/examples/', {host: 'rebound.example'}), 421,
            'a non-loopback Host header reached a page route');
        const identity = await fetch(port, '/fixture-identity');
        assert.equal(identity.status, 200);
        const body = JSON.parse(identity.body);
        assert.equal(body.fixture, 'paste-elements serve-examples.cjs');
        assert.equal(Object.prototype.hasOwnProperty.call(body, 'pid'), false, 'the identity reports a process id');
        assert.equal(Object.prototype.hasOwnProperty.call(body, 'roots'), false, 'the identity reports filesystem roots');
        assert.equal(identity.body.indexOf(path.resolve(__dirname, '..')), -1,
            'the identity response contains the checkout path');
        assert.equal(identity.body.indexOf(path.resolve(pasteCore)), -1,
            'the identity response contains the paste core path');
        assert.ok(Object.keys(body.digests).length >= 10, 'the identity response lost its digests');
    } finally {
        server.kill();
    }
});

test('alias spellings of declared paths answer 404; the declared spellings answer 200', async () => {
    requireCore();
    const {port, server} = await startFixture();
    try {
        const aliases = [
            // A paste.ui module under the wrong tier, an extra
            // directory, or without its extension.
            '/js/paste/ui/utilities/imagesequence.js',
            '/js/paste/ui/scrollrange.js',
            '/js/paste/ui/mediaquery.js',
            '/js/paste/ui/any/dir/imagesequence.js',
            '/js/paste/ui/utilities/extra/scrollrange.js',
            '/js/paste/ui/imagesequence',
            '/js/paste/ui/utilities/animation-frame',
            // Repeated separators fold onto a real file in the
            // filesystem but are not that file's path.
            '/js/paste//paste.js',
            '/examples//index.html',
            // Sequence tiers and frames spelled any other way than the
            // manifest declares them.
            '/generated/sequence/catalog-press/t00/frame-0.png',
            '/generated/sequence/catalog-press/x0/frame-0.png',
            '/generated/sequence/catalog-press/t/frame-0.png',
            '/generated/sequence/catalog-press/t0/frame-00.png',
            '/generated/sequence/catalog-press/t0/frame-01.png',
            '/generated/sequence/catalog-press/t9/frame-0.png',
            '/generated/sequence/catalog-press/t0/frame-12.png',
            // Image variants spelled any other way than the pages
            // reference them.
            '/generated/img/avatar/r00.png',
            '/generated/img/avatar/r3.png',
            '/generated/img/hero/r2.png'
        ];
        for (const alias of aliases) {
            assert.equal(await status(port, alias), 404, alias + ' answered as an alias of a declared path');
        }
        const declared = [
            '/js/paste/paste.js',
            '/js/paste/ui/imagesequence.js',
            '/js/paste/ui/utilities/scrollrange.js',
            '/js/paste/ui/utilities/mediaquery.js',
            '/examples/index.html',
            '/generated/sequence/catalog-press/t1/frame-11.png',
            '/generated/sequence/gallery-hall/t1/frame-15.png',
            '/generated/img/avatar/r2.png',
            '/generated/img/hero/r1.png',
            '/examples/index.html?query#fragment'
        ];
        for (const declaredPath of declared) {
            assert.equal(await status(port, declaredPath), 200, declaredPath + ' no longer serves');
        }
    } finally {
        server.kill();
    }
});

// Sends the request target verbatim, so no client-side URL handling can
// normalize an alias spelling before the fixture sees it.
function rawGet(port, target) {
    return rawStatus(port, 'GET ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: close\r\n\r\n');
}

test('alias spellings sent verbatim answer 404: escapes, backslashes and dot segments', async () => {
    requireCore();
    const {port, server} = await startFixture();
    try {
        const aliases = [
            '/js/paste%2Fpaste.js',
            '/js/paste%2fpaste.js',
            '/js%2Fpaste%2Fui%2Fimagesequence.js',
            '/js/paste/%70aste.js',
            '/js/paste/paste%2Ejs',
            '/js/paste/%2E/paste.js',
            '/js/paste/%2e%2e/paste/paste.js',
            '/js/paste/ui/%2E%2E/paste.js',
            '/js/paste/./paste.js',
            '/js/paste/ui/../paste.js',
            '/js/paste/ui/utilities/../../paste.js',
            '/examples/./index.html',
            '/examples/../examples/index.html',
            '/js/paste\\paste.js',
            '/js/paste%5Cpaste.js',
            '/generated/img/avatar%2Fr0.png',
            '/generated/sequence/catalog-press/t0/./frame-0.png',
            '/generated/sequence/catalog-press/t0/%66rame-0.png'
        ];
        for (const alias of aliases) {
            assert.equal(await rawGet(port, alias), 404, alias + ' answered as an alias of a declared path');
        }
        for (const declaredPath of ['/js/paste/paste.js', '/js/paste/ui/imagesequence.js',
            '/examples/index.html', '/generated/img/avatar/r0.png']) {
            assert.equal(await rawGet(port, declaredPath), 200, declaredPath + ' no longer serves verbatim');
        }
    } finally {
        server.kill();
    }
});

// Every /js/ script src a page under examples/ or a browser check page
// declares, against the three identity lists (the fixture's, the Node
// verifier's and the Java checker's): a page that executes a module the
// identity check never digests could run stale bytes under a green
// verdict. Relative srcs are build outputs another harness serves, and
// each is listed here by page.
const NOT_FIXTURE_SCRIPTS = {'marquee.html': ['example.js']};

function declaredScriptSrcs() {
    const examplesDir = path.join(__dirname, '../examples');
    const srcs = new Set();
    for (const page of fs.readdirSync(examplesDir).filter((name) => name.endsWith('.html'))) {
        const markup = fs.readFileSync(path.join(examplesDir, page), 'utf8');
        const pattern = /<script\b[^>]*\bsrc="([^"]+)"/g;
        let match;
        while ((match = pattern.exec(markup)) !== null) {
            if (match[1].indexOf('/js/') === 0) {
                srcs.add(match[1]);
            } else {
                assert.ok((NOT_FIXTURE_SCRIPTS[page] || []).includes(match[1]),
                    page + ' declares ' + match[1] + ', which the fixture identity does not cover');
            }
        }
    }
    const java = fs.readFileSync(path.join(__dirname, 'ElementsBrowserChecks.java'), 'utf8');
    const checkPages = java.slice(java.indexOf('IDENTITY_PATHS = List.of(') + 1);
    const literal = /"(\/js\/paste\/[^"]+\.js)"/g;
    let match;
    while ((match = literal.exec(checkPages)) !== null) {
        srcs.add(match[1]);
    }
    return srcs;
}

function quotedPaths(text) {
    return [...text.matchAll(/['"](\/js\/paste\/[^'"]+\.js)['"]/g)].map((m) => m[1]);
}

test('the identity lists digest every script the example and check pages declare', async () => {
    requireCore();
    const declared = [...declaredScriptSrcs()].sort();
    assert.ok(declared.length >= 10, 'the scan found almost no declared scripts');
    const verifier = fs.readFileSync(path.join(__dirname, 'verify-fixture-identity.cjs'), 'utf8');
    const verifierList = verifier.slice(verifier.indexOf('const identityPaths = ['));
    const java = fs.readFileSync(path.join(__dirname, 'ElementsBrowserChecks.java'), 'utf8');
    const javaList = java.slice(java.indexOf('IDENTITY_PATHS = List.of('));
    assert.deepEqual(quotedPaths(verifierList.slice(0, verifierList.indexOf('];'))).sort(), declared,
        'verify-fixture-identity.cjs digests a different set');
    assert.deepEqual(quotedPaths(javaList.slice(0, javaList.indexOf(');'))).sort(), declared,
        'ElementsBrowserChecks.java digests a different set');
    const {port, server} = await startFixture();
    try {
        const identity = JSON.parse((await fetch(port, '/fixture-identity')).body);
        assert.deepEqual(Object.keys(identity.digests).sort(), declared,
            'the fixture digests a different set');
        for (const requestPath of declared) {
            assert.equal(typeof identity.digests[requestPath], 'string', requestPath + ' is not served');
        }
    } finally {
        server.kill();
    }
});

test('every module source is served at exactly its declared dist URL', async () => {
    // The host's URL table is explicit, so a module added to modules/
    // without a URL would silently 404. Each source's own define call
    // names its identity (paste.ui.utilities.mediaquery ->
    // /js/paste/ui/utilities/mediaquery.js); that URL must serve the
    // file's bytes, and the other tier's spelling must not.
    requireCore();
    const modulesRoot = path.join(__dirname, '../modules');
    const tierSources = (root) => fs.readdirSync(root)
        .map((name) => path.join(root, name, name + '.js'))
        .filter((file) => fs.existsSync(file));
    const sources = tierSources(modulesRoot)
        .concat(tierSources(path.join(modulesRoot, 'utilities')))
        .concat(tierSources(path.join(modulesRoot, 'form')));
    assert.ok(sources.length >= 10, 'the scan found almost no module sources');
    const {port, server} = await startFixture();
    try {
        for (const file of sources) {
            const declared = /paste\['define'\]\(\s*'(paste\.ui\.[^']+)'/.exec(fs.readFileSync(file, 'utf8'));
            assert.ok(declared, path.basename(file) + ' declares no paste.ui identity');
            const url = '/js/' + declared[1].replace(/\./g, '/') + '.js';
            const served = await fetch(port, url);
            assert.equal(served.status, 200, url + ' does not serve ' + path.basename(file));
            assert.equal(served.body, fs.readFileSync(file, 'utf8'), url + ' serves other bytes');
            const otherTier = url.indexOf('/js/paste/ui/utilities/') === 0
                ? url.replace('/js/paste/ui/utilities/', '/js/paste/ui/')
                : url.replace('/js/paste/ui/', '/js/paste/ui/utilities/');
            assert.equal(await status(port, otherTier), 404, otherTier + ' aliases ' + url);
        }
    } finally {
        server.kill();
    }
});

test('the identity verifier requests the URL it checked, with or without a trailing slash', async () => {
    // The verifier resolves fixture-identity against the base as a
    // directory and runs the loopback check on that same URL object: a
    // base without its trailing slash must not turn the host name into
    // '127.0.0.1fixture-identity', and a non-loopback host is refused
    // before any request.
    requireCore();
    const verifier = path.join(__dirname, 'verify-fixture-identity.cjs');
    const run = (base, nonce) => new Promise((resolve) => {
        execFile(process.execPath, [verifier, base, nonce],
            {env: {...process.env, PASTE_CORE_JS: pasteCore}, timeout: 15000},
            (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr}));
    });
    const nonce = 'verifier-' + process.pid + '-' + Date.now();
    const {port, server} = await startFixture(nonce);
    try {
        const bare = await run('http://127.0.0.1:' + port, nonce);
        assert.equal(bare.code, 0, 'a base without a trailing slash failed: ' + bare.stderr);
        assert.match(bare.stdout, /nonce bound to this run/);
        const slashed = await run('http://localhost:' + port + '/', nonce);
        assert.equal(slashed.code, 0, 'a base with a trailing slash failed: ' + slashed.stderr);
        const foreign = await run('http://127.0.0.1.example:' + port, nonce);
        assert.notEqual(foreign.code, 0, 'a non-loopback host was accepted');
        assert.match(foreign.stderr, /not loopback/);
    } finally {
        server.kill();
    }
});
