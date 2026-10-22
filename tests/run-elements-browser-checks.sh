#!/usr/bin/env bash
set -euo pipefail

# Supply an existing Playwright 1.41 Java runtime; this runner never downloads dependencies.
# PLAYWRIGHT_JAVA_CLASSPATH must include playwright, driver, driver-bundle and gson jars.
# Set PLAYWRIGHT_BROWSERS_PATH if the installed browser cache is not Playwright's default.
# ELEMENTS_CHROMIUM_EXECUTABLE optionally selects another already-installed Chromium binary.
# The actual binary and version are recorded in results.json; the default is bundled Chromium.
# PASTE_CORE_JS must name the src/js directory of a paste release or checkout.
#
# Fixture identity is run-scoped: this runner plants a nonce in the fixture
# process's environment, requires that nonce back from the identity
# response, and requires the SHA-256 of every /js/ script the example and
# check pages declare to equal this checkout's files. A fixture answering from another process,
# another checkout, or another revision cannot stand in as evidence.
#
# The fixture host is started on FIXTURE_PORT (default 8087) unless
# ELEMENTS_URL points at an already-running instance. An occupied requested
# port is a hard failure, not an answer to reuse. An externally managed
# ELEMENTS_URL gets the same per-module digest checks but no process or
# nonce ownership claim. ELEMENTS_SCENARIO_FILTER optionally restricts the
# run to scenario names containing the given text.
: "${PLAYWRIGHT_JAVA_CLASSPATH:?Set PLAYWRIGHT_JAVA_CLASSPATH to the existing Playwright 1.41 runtime jars}"
: "${PASTE_CORE_JS:?Set PASTE_CORE_JS to the src/js directory of a paste release (or checkout)}"
# Physical path: the verifier compares against node's physical cwd.
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
out="$root/target/browser-checks-elements"
mkdir -p "$out/tmp"
# A stale results file must never pass for a fresh run's evidence.
rm -f "$out/results.json" "$out/fixture-identity.json"
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
export TMPDIR="$out/tmp"

port_open() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- 3<&- || return 1
}

server_pid=""
nonce="$(uuidgen 2>/dev/null || printf '%s-%s' "$(date +%s)" "$RANDOM$RANDOM")"
if [[ -z "${ELEMENTS_URL:-}" ]]; then
    port="${FIXTURE_PORT:-8087}"
    if port_open "$port"; then
        echo "fixture port $port is already occupied — whatever answers there is not" >&2
        echo "this run's fixture. Free the port or set FIXTURE_PORT to a different one." >&2
        exit 1
    fi
    FIXTURE_NONCE="$nonce" node "$root/tests/serve-examples.cjs" "$port" > "$out/fixture.log" &
    server_pid=$!
    trap '[[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true' EXIT
    # Readiness is the run's own nonce coming back from this run's own
    # child — never the shape of an endpoint any stale process satisfies.
    # A child that failed to bind dies; kill -0 on it fails the wait.
    ready=""
    for _ in $(seq 1 100); do
        if ! kill -0 "$server_pid" 2>/dev/null; then
            echo "the fixture process exited before answering — see $out/fixture.log" >&2
            exit 1
        fi
        if curl -fs "http://127.0.0.1:$port/fixture-identity" 2>/dev/null | grep -qF "\"nonce\":\"$nonce\""; then
            ready=1
            break
        fi
        sleep 0.1
    done
    if [[ -z "$ready" ]]; then
        echo "no fixture on $port carries this run's nonce — see $out/fixture.log" >&2
        exit 1
    fi
    ELEMENTS_URL="http://127.0.0.1:$port/"
    export ELEMENTS_FIXTURE_NONCE="$nonce"
else
    export ELEMENTS_EXTERNAL_FIXTURE=1
fi
# A supplied URL without a trailing slash must still concatenate — the
# verifier appends its endpoint directly to what it is given.
ELEMENTS_URL="${ELEMENTS_URL%/}/"

# The runner anchors everything that follows at the checkout: the
# identity record, the compiled classes and the results directory all
# live under it, and the verifier confines its record to the caller's
# working directory.
cd -- "$root"

# Digests before browsers: every module the pages execute must serve this
# checkout's bytes, proven independently of the nonce. The record lands in
# fixture-identity.json; a mismatch fails the run before any launch.
node "$root/tests/verify-fixture-identity.cjs" \
    "$ELEMENTS_URL" "${ELEMENTS_FIXTURE_NONCE:--}" "$out/fixture-identity.json"

javac -cp "$PLAYWRIGHT_JAVA_CLASSPATH" -d "$out" "$root/tests/ElementsBrowserChecks.java"
java -Djava.io.tmpdir="$out/tmp" -cp "$out:$PLAYWRIGHT_JAVA_CLASSPATH" \
  ElementsBrowserChecks "$ELEMENTS_URL" "$out" "${ELEMENTS_SCENARIO_FILTER:-}" 2>&1 | tee "$out/run.log"
