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

// Binds a running fixture host to this checkout's bytes. The runner
// invokes this before launching browsers so a stale process or a wrong
// source tree can never produce a green run:
//
//   node tests/verify-fixture-identity.cjs <baseUrl> <nonce|-> <recordPath>
//
// <nonce> is this run's planted FIXTURE_NONCE, or '-' when the fixture is
// externally managed — in that case ownership cannot be proven, the
// reported nonce is only recorded, and the byte digests carry the whole
// check. The verification record is written to <recordPath> whether the
// outcome is pass or fail; exit status is 0 only on a clean verdict.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const baseUrl = process.argv[2];
const expectedNonce = process.argv[3] === '-' ? null : process.argv[3];
const recordPath = process.argv[4] ? resolveRecordPath(process.argv[4]) : null;

const repoRoot = path.resolve(__dirname, '..');
const elementsJs = path.join(repoRoot, 'modules');
const pastestackJs = process.env.PASTE_CORE_JS;

/* Every /js/ script src the example pages and the browser check pages
 * declare. The fixture reports its own digest list, so this verifier
 * keeps its own copy of the path set rather than trusting the fixture to
 * enumerate what matters; serve-examples.test.cjs keeps the copies equal
 * to the declared srcs. */
const identityPaths = [
    '/js/paste/ui/fragment_navigation.js',
    '/js/paste/ui/allowed_chars.js',
    '/js/paste/ui/select.js',
    '/js/paste/ui/form/form_autosave.js',
    '/js/paste/ui/imageupload.js',
    '/js/paste/ui/js_tooltip.js',
    '/js/paste/ui/navigate_on_change.js',
    '/js/paste/ui/prevent_double_submit.js',
    '/js/paste/ui/sortable.js',
    '/js/paste/ui/update_text_on_input_change.js',

    '/js/paste/paste.js',
    '/js/paste/guid.js',
    '/js/paste/util.js',
    '/js/paste/oop.js',
    '/js/paste/dom.js',
    '/js/paste/event.js',
    '/js/paste/has.js',
    '/js/paste/polyfills/getcomputedstyle.js',
    '/js/paste/ui/utilities/animation-frame.js',
    '/js/paste/ui/utilities/scrollrange.js',
    '/js/paste/ui/utilities/imageresolution.js',
    '/js/paste/ui/utilities/mediaquery.js',
    '/js/paste/ui/heroscroll.js',
    '/js/paste/ui/stickynav.js',
    '/js/paste/ui/scrollscrub.js',
    '/js/paste/ui/progressiveresolution.js',
    '/js/paste/ui/imagesequence.js',
    '/js/paste/ui/multistate.js',
    '/js/paste/ui/autogrow.js', '/js/paste/ui/smoothscroll.js',
    '/js/paste/io.js', '/js/paste/ui/utilities/form-dom.js', '/js/paste/ui/utilities/io-html-fragment.js', '/js/paste/ui/form/form_validity.js', '/js/paste/ui/form/form_apply.js', '/js/paste/ui/form/form_html.js', '/js/paste/ui/scrollspy.js',
    '/js/paste/ui/lazy_loader.js', '/js/paste/ui/carousel.js'
];

// A request path resolves only inside the two known source roots: the
// normalized result must still sit under the root it was joined to, so
// a relative slice can never escape the checkout, whatever the fixed
// list above names.
function confined(root, resolved) {
    return resolved.indexOf(root + path.sep) === 0 ? resolved : null;
}

function resolveLocal(requestPath) {
    if (requestPath.indexOf('/js/paste/ui/') === 0) {
        const basename = path.basename(requestPath, '.js');
        const tier = requestPath.indexOf('/js/paste/ui/utilities/') === 0 ? 'utilities' : requestPath.indexOf('/js/paste/ui/form/') === 0 ? 'form' : '';
        return confined(elementsJs, path.normalize(path.join(elementsJs, tier, basename, basename + '.js')));
    }
    if (requestPath.indexOf('/js/paste/') === 0) {
        if (!pastestackJs) { return null; }
        const root = path.resolve(pastestackJs);
        return confined(root, path.normalize(path.join(root, requestPath.slice('/js/paste/'.length))));
    }
    return null;
}

// The physical location of a path that may not exist yet: the deepest
// existing ancestor is resolved through realpath and the missing tail is
// appended. A shell's logical `pwd` keeps symlinked components while
// process.cwd() is already physical, so both sides of the containment
// check below must be physical or a symlinked checkout never passes.
function physicalPath(given) {
    let existing = path.resolve(given);
    const tail = [];
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) {
            break;
        }
        tail.unshift(path.basename(existing));
        existing = parent;
    }
    return path.join(fs.realpathSync(existing), ...tail);
}

// The evidence record is the run's own artifact: it lands under the
// working tree or nowhere — an escaping path is refused before any byte
// is written.
function resolveRecordPath(given) {
    const resolved = physicalPath(given);
    const workingTree = fs.realpathSync(process.cwd());
    if (resolved.indexOf(workingTree + path.sep) !== 0) {
        throw new Error('record path must stay inside the working tree: ' + given);
    }
    return resolved;
}

// The fixture contract is loopback-only — a verifier pointed at any
// other host is not checking this fixture, so the URL is refused
// before the first request. The check runs on the URL object the
// request is made with, never on a different spelling of it.
function loopbackOnly(url) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (host !== 'localhost' && host !== '127.0.0.1' && host !== '::1') {
        throw new Error('fixture URL is not loopback: ' + url.hostname);
    }
}

function sha256File(file) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch (error) {
        return null;
    }
}

function fetchIdentity() {
    return new Promise(function (resolve, reject) {
        let target;
        try {
            // The endpoint resolves against the base as a directory: a
            // base given without its trailing slash still names the same
            // host and path prefix, so 'http://127.0.0.1:8087' and
            // 'http://127.0.0.1:8087/' both request
            // http://127.0.0.1:8087/fixture-identity.
            const base = new URL(baseUrl);
            if (base.pathname.slice(-1) !== '/') {
                base.pathname += '/';
            }
            base.search = '';
            base.hash = '';
            target = new URL('fixture-identity', base);
            if (target.protocol !== 'http:' && target.protocol !== 'https:') {
                throw new Error('fixture URL is not http or https: ' + baseUrl);
            }
            loopbackOnly(target);
        } catch (error) {
            reject(error);
            return;
        }
        const transport = target.protocol === 'https:' ? https : http;
        const request = transport.get(target, function (response) {
            const chunks = [];
            response.on('data', function (chunk) { chunks.push(chunk); });
            response.on('end', function () {
                if (response.statusCode !== 200) {
                    reject(new Error('fixture-identity answered ' + response.statusCode));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                } catch (error) {
                    reject(new Error('fixture-identity did not parse as JSON'));
                }
            });
        });
        request.on('error', function (error) {
            reject(new Error('fixture-identity unreachable: ' + error.message));
        });
        request.setTimeout(5000, function () {
            request.destroy(new Error('fixture-identity timed out'));
        });
    });
}

const failures = [];
function fail(message) {
    failures.push(message);
}

fetchIdentity().then(function (identity) {
    const record = {
        checkedAt: new Date().toISOString(),
        baseUrl: baseUrl,
        nonceExpected: expectedNonce,
        nonceReported: identity && identity.nonce !== undefined ? identity.nonce : null,
        nonceVerified: false,
        childOwned: expectedNonce !== null,
        port: identity ? identity.port : null,
        checks: []
    };
    try {
        if (!identity || identity.fixture !== 'paste-elements serve-examples.cjs') {
            fail('the answering service is not this fixture — identity marker absent');
        }
        if (expectedNonce !== null) {
            if (identity && identity.nonce === expectedNonce) {
                record.nonceVerified = true;
            } else {
                fail('the answering fixture is not the process this run spawned (nonce mismatch)');
            }
        }
        const digests = (identity && identity.digests) || {};
        identityPaths.forEach(function (requestPath) {
            const localFile = resolveLocal(requestPath);
            const localDigest = localFile ? sha256File(localFile) : null;
            const servedDigest = Object.prototype.hasOwnProperty.call(digests, requestPath)
                ? digests[requestPath] : undefined;
            const ok = servedDigest !== undefined && servedDigest !== null &&
                localDigest !== null && servedDigest === localDigest;
            record.checks.push({
                path: requestPath,
                servedDigest: servedDigest === undefined ? null : servedDigest,
                localDigest: localDigest,
                ok: ok
            });
            if (!ok) {
                fail('served bytes differ from this checkout for ' + requestPath +
                    ' (served=' + servedDigest + ', local=' + localDigest + ')');
            }
        });
    } catch (error) {
        fail('verification error: ' + error.message);
    }
    record.ok = failures.length === 0;
    record.failures = failures;
    if (recordPath) {
        fs.mkdirSync(path.dirname(recordPath), {recursive: true});
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    }
    if (record.ok) {
        process.stdout.write('fixture identity verified' +
            (record.nonceVerified ? ' (nonce bound to this run)' : ' (external fixture — digests only)') + '\n');
    } else {
        failures.forEach(function (message) {
            process.stderr.write('fixture identity failed: ' + message + '\n');
        });
        process.exitCode = 1;
    }
}).catch(function (error) {
    const record = {
        checkedAt: new Date().toISOString(),
        baseUrl: baseUrl,
        nonceExpected: expectedNonce,
        ok: false,
        failures: [error.message]
    };
    if (recordPath) {
        fs.mkdirSync(path.dirname(recordPath), {recursive: true});
        fs.writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    }
    process.stderr.write('fixture identity failed: ' + error.message + '\n');
    process.exitCode = 1;
});
