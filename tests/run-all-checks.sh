#!/usr/bin/env bash
set -euo pipefail
# Playwright 1.41 otherwise forces loopback through the configured dead proxy.
export PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
: "${PASTE_CORE_JS:?Set PASTE_CORE_JS to the paste src/js directory}"
: "${PLAYWRIGHT_JAVA_CLASSPATH:?Set PLAYWRIGHT_JAVA_CLASSPATH to installed runtime jars}"
if [[ -n "${ELEMENTS_SCENARIO_FILTER:-}" || -n "${ELEMENTS_DISABLE_MODULE:-}" || -n "${PASTE_SOURCE_ROOT:-}" || -n "${ELEMENTS_SOURCE_ROOT:-}" || -n "${ELEMENTS_CONSISTENCY_BUILD:-}" ]]; then
    echo 'The complete check requires the current source tree and every scenario.' >&2
    exit 1
fi
out="$root/target/all-checks"
mkdir -p "$out"
rm -f "$out/marquee-url"
: > "$out/syntax.log"
stage="syntax"
server_pid=""
trap 'status=$?; [[ -z "$server_pid" ]] || kill "$server_pid" 2>/dev/null || true; if [[ $status != 0 ]]; then echo "FAIL $stage (see $out)" >&2; fi' EXIT
while IFS= read -r -d '' file; do
    node --check "$file" >> "$out/syntax.log" 2>&1
done < <(find modules tests -type f \( -name '*.js' -o -name '*.cjs' -o -name '*.mjs' \) -print0)
printf 'PASS syntax\n'
stage="Node suite"
node --test tests/*.test.cjs > "$out/node.log" 2>&1
printf 'PASS Node suite\n'
stage="source headers"
node --test tests/source-headers.test.cjs > "$out/source-headers.log" 2>&1
printf 'PASS source headers\n'
stage="style contracts"
node tests/style-contract-checks.cjs --browser > "$out/style-contract.log" 2>&1
node tests/style-contract-checks.cjs --browser --minify > "$out/style-contract-minified.log" 2>&1
printf 'PASS style contracts (source and minified)\n'
stage="fresh consistency assets"
assetgraph="${PASTE_ASSETGRAPH_BIN:-paste-assetgraph}"
"$assetgraph" build --config tests/consistency-assets.conf > "$out/consistency-build.log" 2>&1
stage="native consistency and responsibility"
for engine in chromium firefox webkit; do
    executable=""
    if [[ "$engine" = chromium ]]; then executable="${ELEMENTS_BROWSER_EXECUTABLE:-}"; fi
    ELEMENTS_BROWSER="$engine" ELEMENTS_BROWSER_EXECUTABLE="$executable" \
        node tests/consistency-browser-checks.cjs > "$out/consistency-$engine.log" 2>&1
    ELEMENTS_BROWSER="$engine" ELEMENTS_BROWSER_EXECUTABLE="$executable" \
        node tests/responsibility-browser-checks.cjs > "$out/responsibility-$engine.log" 2>&1
done
printf 'PASS native consistency and responsibility (Chromium, Firefox, WebKit)\n'
stage="native select (source and minified)"
"$assetgraph" build --config tests/select-assets.conf > "$out/select-build.log" 2>&1
node tests/select-browser-checks.cjs > "$out/select-browser.log" 2>&1
printf 'PASS native select (source and minified; Chromium, Firefox, WebKit)\n'
stage="restored modules (source and optimized)"
node tests/fragment-browser-checks.cjs > "$out/fragment-browser.log" 2>&1
node tests/restoration-browser-checks.cjs > "$out/restoration-browser.log" 2>&1
printf 'PASS restored modules (source and optimized; Chromium, Firefox, WebKit)\n'
stage="fresh marquee build and identity"
node tests/build-marquee-example.cjs "$assetgraph" > "$out/marquee-build.log" 2>&1
# A private ephemeral loopback server serves only the three built artifacts.
node - "$root/target/marquee-example" "$out/marquee-url" <<'JS' > "$out/marquee-server.log" 2>&1 &
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const files = new Map([['/', ['index.html', 'text/html']], ['/example.js', ['example.js', 'text/javascript']], ['/example.css', ['example.css', 'text/css']]]);
const server = http.createServer((req, res) => {
    const file = files.get(req.url);
    if (!file) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file[1]);
    res.end(fs.readFileSync(path.join(process.argv[2], file[0])));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(process.argv[3], `http://127.0.0.1:${server.address().port}/`));
JS
server_pid=$!
for ((attempt=0; attempt<100; attempt++)); do
    kill -0 "$server_pid"
    [[ ! -s "$out/marquee-url" ]] || break
    sleep 0.1
done
export MARQUEE_URL="$(cat "$out/marquee-url")"
node tests/build-marquee-example.cjs --verify "$MARQUEE_URL" "$out/marquee-identity.json" > "$out/marquee-verify.log" 2>&1
printf 'PASS fresh marquee build and identity\n'
stage="elements browsers"
bash tests/run-elements-browser-checks.sh > "$out/elements.log" 2>&1
printf 'PASS elements browsers (Chromium, Firefox, WebKit)\n'
stage="marquee browsers"
bash tests/run-marquee-browser-checks.sh > "$out/marquee.log" 2>&1
printf 'PASS marquee browsers (Chromium, Firefox, WebKit)\n'
stage="browser coverage in this run"
# Declared scenarios that were commented out, unreachable or failed on an
# engine are not coverage: the runs' own results must show a pass for every
# element module on every engine.
ELEMENTS_BROWSER_RESULTS="$root/target/browser-checks-elements/results.json" \
MARQUEE_BROWSER_RESULTS="$root/target/browser-checks/results.json" \
    node --test tests/browser-coverage.test.cjs > "$out/browser-coverage.log" 2>&1
printf 'PASS browser coverage in this run\n'
