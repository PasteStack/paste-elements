#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
: "${PASTE_CORE_JS:?Set PASTE_CORE_JS to the paste src/js directory}"
: "${PLAYWRIGHT_JAVA_CLASSPATH:?Set PLAYWRIGHT_JAVA_CLASSPATH to installed runtime jars}"
if [[ -n "${ELEMENTS_SCENARIO_FILTER:-}" || -n "${ELEMENTS_DISABLE_MODULE:-}" || -n "${PASTE_SOURCE_ROOT:-}" ]]; then
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
stage="fresh marquee build and identity"
node tests/build-marquee-example.cjs > "$out/marquee-build.log" 2>&1
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
tests/run-elements-browser-checks.sh > "$out/elements.log" 2>&1
printf 'PASS elements browsers (Chromium, Firefox, WebKit)\n'
stage="marquee browsers"
tests/run-marquee-browser-checks.sh > "$out/marquee.log" 2>&1
printf 'PASS marquee browsers (Chromium, Firefox, WebKit)\n'
stage="browser coverage in this run"
# Declared scenarios that were commented out, unreachable or failed on an
# engine are not coverage: the runs' own results must show a pass for every
# element module on every engine.
ELEMENTS_BROWSER_RESULTS="$root/target/browser-checks-elements/results.json" \
MARQUEE_BROWSER_RESULTS="$root/target/browser-checks/results.json" \
    node --test tests/browser-coverage.test.cjs > "$out/browser-coverage.log" 2>&1
printf 'PASS browser coverage in this run\n'
