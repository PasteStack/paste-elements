'use strict';

// Local test fixture host for the paste.ui enhancement examples.
// Serves the handwritten example pages under examples/, the paste core
// and paste.ui sources those pages declare, and the generated PNGs they
// reference (image size variants under /generated/img/ and sequence
// frames under /generated/sequence/), so the journeys run without any
// application route or upstream service.
//
//   PASTE_CORE_JS=/path/to/paste/src/js node tests/serve-examples.cjs [port]
//
// The port defaults to 8087; 0 asks the system for a free one. The
// startup line names the port actually bound, so a caller that passed 0
// reads it from there. Open http://127.0.0.1:8087/examples/ afterwards. The core `paste`
// modules are a separate release; PASTE_CORE_JS names that checkout or
// release's src/js directory — this repository must not encode where a
// machine keeps it. Every paste.ui element URL resolves through this
// repository's modules/<name>/<name>.js and every paste.ui.utilities URL
// through modules/utilities/<name>/<name>.js.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const port = process.argv[2] === undefined ? 8087 : Number(process.argv[2]);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('the port must be an integer from 0 to 65535: ' + process.argv[2]);
}
const repoRoot = path.resolve(__dirname, '..');
const pastestackJs = process.env.PASTE_CORE_JS;
if (!pastestackJs || !fs.existsSync(path.join(pastestackJs, 'paste.js'))) {
    throw new Error('Set PASTE_CORE_JS to the src/js directory of a paste release (or checkout) before serving the examples');
}
const elementsJs = path.join(repoRoot, 'modules');
const examplesDir = path.join(repoRoot, 'examples');
// The run identity a runner plants in this process's environment. The
// identity endpoint reports it verbatim so a check can prove the process
// answering is the one it spawned — never invented or read from a request.
const fixtureNonce = process.env.FIXTURE_NONCE || null;

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.css': 'text/css; charset=utf-8'
};

/* A small deterministic PNG writer: enough surface for decode-capable
 * fixtures without committing binary assets. */
const crcTable = (function () {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c;
    }
    return table;
}());

function crc32(buffer) {
    let crc = -1;
    for (let index = 0; index < buffer.length; index += 1) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[index]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4);
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.slice(4, 8 + data.length)), 8 + data.length);
    return chunk;
}

const pngCache = {};
function pngImage(width, height, seed) {
    const key = [width, height, seed].join('|');
    if (pngCache[key]) {
        return pngCache[key];
    }
    const raw = Buffer.alloc((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
        const row = y * (width * 3 + 1);
        raw[row] = 0;
        for (let x = 0; x < width; x += 1) {
            const at = row + 1 + x * 3;
            raw[at] = (x * 4 + seed * 37) % 256;
            raw[at + 1] = (y * 4 + seed * 53) % 256;
            raw[at + 2] = ((x + y) * 2 + seed * 91) % 256;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw, {level: 9})),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
    pngCache[key] = png;
    return png;
}

// Route dictionaries keyed by request-path segments must have no
// prototype: a lookup like table['constructor'] resolving through
// Object.prototype dereferences an inherited member as if it were a
// declared fixture — truthy, wrong-typed, and a crash in the handler.
// Null-prototype tables answer only what was authored.
function routeTable(entries) {
    return Object.assign(Object.create(null), entries);
}

/* The generated image size variants the example pages reference:
 * /generated/img/<name>/r<index>.png at each listed width and height. */
const imageVariants = routeTable({
    'avatar': {seed: 7, sizes: [[80, 80], [160, 160], [320, 320]]},
    'product': {seed: 23, sizes: [[240, 180], [480, 360], [960, 720]]},
    'hero': {seed: 41, sizes: [[640, 360], [1280, 720]]}
});

/* The generated sequence frames the example pages reference:
 * /generated/sequence/<name>/t<tier>/frame-<index>.png, count frames at
 * each listed tier size. */
const sequences = routeTable({
    'catalog-press': {seed: 3, count: 12, sizes: [[320, 240], [640, 480]]},
    'gallery-hall': {seed: 11, count: 16, sizes: [[320, 180], [640, 360]]}
});

function send(response, status, body, type) {
    response.writeHead(status, {'content-type': type || 'application/octet-stream', 'cache-control': 'no-store'});
    response.end(body);
}

/* The fixture is declared, not discovered: each root is walked once at
 * startup and only a file that index recorded can ever be served, so a
 * request path can only select an authored fixture, never reach a file the
 * repository did not put there. */
function indexFiles(root) {
    const files = new Set();
    (function walk(dir) {
        fs.readdirSync(dir, {withFileTypes: true}).forEach(function (entry) {
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(child);
            else if (entry.isFile()) files.add(child);
        });
    })(root);
    return files;
}

const fixtureIndex = new Map(
    [examplesDir, elementsJs, pastestackJs].map(function (dir) {
        const root = path.resolve(dir);
        return [root, indexFiles(root)];
    })
);

/* A request path selects a file only when it spells that file's
 * repository-relative path exactly: no empty or dot segments, no
 * separator spellings the filesystem would fold together. Anything the
 * path module would normalize into an indexed file is an alias, and an
 * alias answers 404 like any other undeclared path. */
function indexedFile(root, requestPath) {
    const segments = requestPath.split('/');
    let index;
    for (index = 0; index < segments.length; index += 1) {
        if (segments[index] === '' || segments[index] === '.' || segments[index] === '..' ||
                segments[index].indexOf('\\') !== -1) {
            return null;
        }
    }
    const resolved = path.join(root, ...segments);
    return fixtureIndex.get(root).has(resolved) ? resolved : null;
}

function serveFile(response, baseDir, requestPath) {
    const resolved = indexedFile(path.resolve(baseDir), requestPath);
    if (!resolved) {
        send(response, 404, 'not found', 'text/plain');
        return;
    }
    send(response, 200, fs.readFileSync(resolved), mime[path.extname(resolved)] || 'application/octet-stream');
}

/* The paste.ui URLs this host answers, each spelled exactly as its
 * module's dist identity: paste.ui.<name> at /js/paste/ui/<name>.js and
 * paste.ui.utilities.<name> at /js/paste/ui/utilities/<name>.js. The
 * source checkout keeps each element under modules/<name>/<name>.js and
 * each utility under modules/utilities/<name>/<name>.js. A utility
 * addressed as an element, an element addressed as a utility, an extra
 * directory or a missing extension is not one of these URLs and answers
 * 404. A new module is added here when it is added to modules/; the
 * suite fails while a module source has no URL in this table. */
const uiElements = [
    'autogrow', 'form', 'heroscroll', 'imagesequence', 'io-reply-fragment-envelope',
    'marquee', 'multistate', 'progressiveresolution', 'scrollscrub', 'scrollspy',
    'smoothscroll', 'stickynav'
];
const uiUtilities = ['animation-frame', 'imageresolution', 'mediaquery', 'scrollrange', 'throttle'];
const uiModuleUrls = routeTable({});
uiElements.forEach(function (name) {
    uiModuleUrls['/js/paste/ui/' + name + '.js'] = name + '/' + name + '.js';
});
uiUtilities.forEach(function (name) {
    uiModuleUrls['/js/paste/ui/utilities/' + name + '.js'] = 'utilities/' + name + '/' + name + '.js';
});

/* One resolution for every /js/ URL — the identity digests below must
 * name the same file a request would get, so the endpoint and the routes
 * share this single mapping. Every /js/paste/ path outside paste/ui/
 * resolves inside the supplied paste core tree, spelled exactly as the
 * file sits there. */
function resolveJsFile(pathname) {
    if (pathname.indexOf('/js/paste/ui/') === 0) {
        const relative = uiModuleUrls[pathname];
        return relative ? indexedFile(path.resolve(elementsJs), relative) : null;
    }
    if (pathname.indexOf('/js/paste/') === 0) {
        return indexedFile(path.resolve(pastestackJs), pathname.slice('/js/paste/'.length));
    }
    return null;
}

function serveResolved(response, resolved) {
    if (!resolved) {
        send(response, 404, 'not found', 'text/plain');
        return;
    }
    send(response, 200, fs.readFileSync(resolved), mime[path.extname(resolved)] || 'application/octet-stream');
}

/* Every /js/ script src the example pages and the browser check pages
 * declare. The identity response digests exactly the file each of these
 * requests would serve; serve-examples.test.cjs keeps this list equal to
 * the script srcs those pages declare. */
const identityPaths = [
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
    '/js/paste/ui/smoothscroll.js',
    '/js/paste/ui/multistate.js',
    '/js/paste/ui/autogrow.js',
    '/js/paste/io.js', '/js/paste/ui/form.js', '/js/paste/ui/scrollspy.js'
];

/* The routed path is the request target exactly as the client wrote it,
 * never a parser's normalization of it. Every declared path is plain
 * ASCII that needs no escaping, so a target carrying a percent-escape
 * (%2F, %5C, %2E or any other), a backslash, or a '.' or '..' segment is
 * an alias spelling and answers 404 — whatever file it would fold onto.
 * Returns the path, null for an alias, or undefined for a target that is
 * not a path at all. */
function declaredSpelling(target) {
    const end = target.search(/[?#]/);
    const rawPath = end === -1 ? target : target.slice(0, end);
    if (rawPath.charAt(0) !== '/') {
        return undefined;
    }
    if (/%2f|%5c|%2e|\\/i.test(rawPath) || /(^|\/)\.\.?(\/|$)/.test(rawPath)) {
        return null;
    }
    let decoded;
    try {
        decoded = decodeURIComponent(rawPath);
    } catch (error) {
        return undefined;
    }
    return decoded === rawPath ? rawPath : null;
}

// The fixture binds loopback only, but a browser on the same machine can
// still be pointed at it through a hostile name that resolves to
// 127.0.0.1 (DNS rebinding). Only a request that names a loopback host is
// answered; anything else is refused before any route runs.
const LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;

const server = http.createServer(function (request, response) {
    let pathname;
    if (!LOOPBACK_HOST.test(String(request.headers.host || ''))) {
        send(response, 421, 'the fixture answers loopback host names only', 'text/plain');
        return;
    }
    // A request target that is not an origin-form path, or that the URL
    // parser rejects (e.g. '//['), is the client's error: it answers 400
    // and the host keeps serving.
    pathname = declaredSpelling(String(request.url));
    try {
        new URL(request.url, 'http://fixture.test');
    } catch (error) {
        pathname = undefined;
    }
    if (pathname === undefined) {
        send(response, 400, 'bad request', 'text/plain');
        return;
    }
    if (pathname === null) {
        send(response, 404, 'not found', 'text/plain');
        return;
    }

    if (pathname === '/fixture-identity') {
        // Test-only run identity: the planted nonce plus the SHA-256 of
        // the bytes each declared module URL would serve right now. A
        // runner verifies both against the checkout it launched from —
        // an answer with the right shape but another process's bytes or
        // nonce cannot stand in for this run's fixture.
        const digests = {};
        identityPaths.forEach(function (requestPath) {
            const resolved = resolveJsFile(requestPath);
            digests[requestPath] = resolved
                ? crypto.createHash('sha256').update(fs.readFileSync(resolved)).digest('hex')
                : null;
        });
        // No filesystem location or process detail is reported: the
        // nonce and the digests are the whole proof a runner needs.
        send(response, 200, JSON.stringify({
            fixture: 'paste-elements serve-examples.cjs',
            nonce: fixtureNonce,
            port: request.socket.localPort,
            digests: digests
        }), 'application/json; charset=utf-8');
        return;
    }
    if (pathname === '/' || pathname === '/examples/') {
        serveFile(response, examplesDir, 'index.html');
        return;
    }
    if (pathname.indexOf('/examples/') === 0) {
        serveFile(response, examplesDir, pathname.slice('/examples/'.length));
        return;
    }
    if (pathname.indexOf('/js/paste/') === 0) {
        serveResolved(response, resolveJsFile(pathname));
        return;
    }
    if (pathname.indexOf('/generated/sequence/') === 0) {
        // Exactly the declared spellings: tier t<digit> and
        // frame-<n>.png with no leading zeros, so no other spelling
        // (t00, x0, t, frame-01.png) aliases a declared frame.
        const parts = pathname.slice('/generated/sequence/'.length).split('/');
        const sequence = sequences[parts[0]];
        const tier = parts.length === 3 ? /^t(\d)$/.exec(parts[1]) : null;
        const frame = parts.length === 3 ? /^frame-(0|[1-9]\d*)\.png$/.exec(parts[2]) : null;
        if (sequence && tier && frame) {
            const sizeIndex = Number(tier[1]);
            const index = Number(frame[1]);
            const size = sequence.sizes[sizeIndex];
            if (size && index < sequence.count) {
                send(response, 200, pngImage(size[0], size[1], sequence.seed + sizeIndex * 97 + index), 'image/png');
                return;
            }
        }
    }
    if (pathname.indexOf('/generated/img/') === 0) {
        const parts = pathname.slice('/generated/img/'.length).split('/');
        const image = imageVariants[parts[0]];
        const variant = parts.length === 2 ? /^r(0|[1-9]\d*)\.png$/.exec(parts[1]) : null;
        if (image && variant) {
            const index = Number(variant[1]);
            const size = image.sizes[index];
            if (size) {
                send(response, 200, pngImage(size[0], size[1], image.seed + index), 'image/png');
                return;
            }
        }
    }
    send(response, 404, 'not found', 'text/plain');
});

// A request the HTTP parser itself rejects never reaches the handler;
// answer it 400 on its own socket so one malformed client cannot take
// the host down or leave the connection hanging.
server.on('clientError', function (error, socket) {
    if (socket.writable) {
        socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    } else {
        socket.destroy(error);
    }
});

server.listen(port, '127.0.0.1', function () {
    process.stdout.write('paste-elements fixture host: http://127.0.0.1:' + server.address().port + '/examples/\n');
});
