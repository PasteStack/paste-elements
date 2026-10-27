#!/usr/bin/env bash
set -euo pipefail
# Playwright 1.41 otherwise forces loopback through the configured dead proxy.
export PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK=1

# Supply an existing Playwright 1.41 Java runtime; this runner never downloads dependencies.
# PLAYWRIGHT_JAVA_CLASSPATH must include playwright, driver, driver-bundle and gson jars.
# Set PLAYWRIGHT_BROWSERS_PATH if the installed browser cache is not Playwright's default.
# MARQUEE_CHROMIUM_EXECUTABLE optionally selects another already-installed Chromium binary.
# The actual binary and version are recorded in results.json; the default is bundled Chromium.
# Build/serve the standalone example first; MARQUEE_URL defaults to its local test server.
# PASTE_CORE_JS must name the same paste src/js directory the build read.
#
# Before any browser launches, the served example is bound to this
# checkout: tests/build-marquee-example.cjs --verify requires the source
# tree hash recorded at build time to equal the current sources, and the
# served index.html, example.js and example.css to be that build's bytes.
# A stale build or a server answering with other bytes fails the run; the
# record lands in marquee-identity.json.
: "${PLAYWRIGHT_JAVA_CLASSPATH:?Set PLAYWRIGHT_JAVA_CLASSPATH to the existing Playwright 1.41 runtime jars}"
: "${PASTE_CORE_JS:?Set PASTE_CORE_JS to the src/js directory of the paste release (or checkout) the example was built from}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/target/browser-checks"
mkdir -p "$out/tmp"
# A stale results file must never pass for a fresh run's evidence.
rm -f "$out/results.json" "$out/marquee-identity.json"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
cd -- "$root"
export TMPDIR="$out/tmp"
marquee_url="${MARQUEE_URL:-http://127.0.0.1:8077/}"
node "$root/tests/build-marquee-example.cjs" --verify "$marquee_url" "$out/marquee-identity.json"
javac -encoding UTF-8 -cp "$PLAYWRIGHT_JAVA_CLASSPATH" -d "$out" "$root/tests/MarqueeBrowserChecks.java"
java -Djava.io.tmpdir="$out/tmp" -cp "$out:$PLAYWRIGHT_JAVA_CLASSPATH" \
  MarqueeBrowserChecks "$marquee_url" "$out" 2>&1 | tee "$out/run.log"
