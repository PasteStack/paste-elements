#!/usr/bin/env bash
set -euo pipefail

# Supply an existing Playwright 1.41 Java runtime; this runner never downloads dependencies.
# PLAYWRIGHT_JAVA_CLASSPATH must include playwright, driver, driver-bundle and gson jars.
# Set PLAYWRIGHT_BROWSERS_PATH if the installed browser cache is not Playwright's default.
# MARQUEE_CHROMIUM_EXECUTABLE optionally selects another already-installed Chromium binary.
# The actual binary and version are recorded in results.json; the default is bundled Chromium.
# Build/serve the standalone example first; MARQUEE_URL defaults to its local test server.
: "${PLAYWRIGHT_JAVA_CLASSPATH:?Set PLAYWRIGHT_JAVA_CLASSPATH to the existing Playwright 1.41 runtime jars}"
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
out="$root/target/browser-checks"
mkdir -p "$out/tmp"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
cd -- "$root"
export TMPDIR="$out/tmp"
javac -cp "$PLAYWRIGHT_JAVA_CLASSPATH" -d "$out" "$root/tests/MarqueeBrowserChecks.java"
java -Djava.io.tmpdir="$out/tmp" -cp "$out:$PLAYWRIGHT_JAVA_CLASSPATH" \
  MarqueeBrowserChecks "${MARQUEE_URL:-http://127.0.0.1:8077/}" "$out" 2>&1 | tee "$out/run.log"
