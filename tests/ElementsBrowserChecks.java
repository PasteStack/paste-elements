import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonParser;
import com.google.gson.JsonElement;
import com.microsoft.playwright.*;
import com.microsoft.playwright.options.ReducedMotion;
import com.microsoft.playwright.options.WaitUntilState;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;

/**
 * Real browser acceptance checks for the paste.ui enhancement modules, served
 * by tests/serve-examples.cjs. The pages load the actual paste loader,
 * event module and animation-frame — nothing is faked. See
 * run-elements-browser-checks.sh for the offline runner.
 *
 * Scenario contract: the name states the protected behavior; require()
 * records the assertions that fail on its regression in results.json.
 * Each scenario must also call active()/awaitActive() with observable
 * enhancement activity, or cite a successful positive twin for a deliberate
 * disabled/capability control. Native-platform and stylesheet checks use
 * their corresponding positive behavior. A loaded script alone is never
 * an activity control. The runner rejects missing assertions or controls
 * and validates the full define dependency graph of every scenario page.
 * tests/browser-coverage.test.cjs requires a scenario for every Element.
 */
public final class ElementsBrowserChecks {
    private static final List<Map<String, Object>> RESULTS = new ArrayList<>();
    // Executed scenarios per browser, kept apart from the fixture-identity
    // result — a run whose filter selects nothing must report it, not
    // count the identity check as a pass.
    private static final Map<String, Integer> SELECTED_BY_BROWSER = new LinkedHashMap<>();
    private static String url;
    private static Path output;
    private static String nameFilter;
    private static List<String> assertions;
    private static List<String> controls;

    private interface Check { void run(Page page, Map<String, Object> evidence) throws Exception; }

    private static void require(boolean condition, String message) {
        if (assertions != null) assertions.add(message);
        if (!condition) throw new AssertionError(message);
    }

    private static void active(boolean condition, String message) {
        require(condition, "positive control: " + message);
        controls.add(message);
    }

    private static void awaitActive(Page page, String expression) {
        awaitActive(page, expression, null, new Page.WaitForFunctionOptions());
    }

    private static void awaitActive(Page page, String expression, Object argument) {
        awaitActive(page, expression, argument, new Page.WaitForFunctionOptions());
    }

    private static void awaitActive(Page page, String expression, Object argument, Page.WaitForFunctionOptions options) {
        page.waitForFunction(expression, argument, options);
        active(true, "observed " + expression);
    }

    // Waits for an end state on the page's own clock rather than the
    // wall's: `expression` is tested once per animation frame the page
    // receives, and the deadline is reached only after at least `frames`
    // of them and `timelineMs` of document-timeline advance — a starved
    // renderer that stops delivering frames extends the wait instead of
    // failing it. `backstopMs` of wall time only bounds a page that never
    // delivers another frame. The result names whether the state was
    // reached, the frames delivered, the document timeline at start and
    // end, the wall time taken and `state` read on the page at the end,
    // so a failure tells a stalled page from a stalled module.
    private static Map<String, Object> awaitInFrames(Page page, String expression, Object argument,
                                                     int frames, double timelineMs, String state, double backstopMs) {
        long started = System.nanoTime();
        page.evaluate("([argument, frames, timelineMs]) => { const test = (" + expression + ");" +
            " const now = () => document.timeline ? document.timeline.currentTime : null;" +
            " const w = window.__pasteFrameWait = {start: now(), end: null, frames: 0, reached: false, done: false};" +
            " w.end = w.start;" +
            " const tick = () => { if (w.done) return; w.frames += 1; w.end = now();" +
            " if (test(argument)) { w.reached = w.done = true; return; }" +
            " if (w.frames >= frames && (w.start === null || w.end === null || w.end - w.start >= timelineMs)) {" +
            " w.done = true; return; }" +
            " requestAnimationFrame(tick); };" +
            " requestAnimationFrame(tick); }", java.util.Arrays.asList(argument, frames, timelineMs));
        boolean finished;
        try {
            page.waitForFunction("() => window.__pasteFrameWait.done", null,
                new Page.WaitForFunctionOptions().setTimeout(backstopMs).setPollingInterval(100));
            finished = true;
        } catch (PlaywrightException backstop) {
            finished = false;
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> result = new LinkedHashMap<>((Map<String, Object>) page.evaluate(
            "() => { const w = window.__pasteFrameWait; w.done = true;" +
            " return {reached: w.reached, frames: w.frames, timelineStart: w.start, timelineEnd: w.end," +
            " state: (" + state + ")()}; }"));
        result.put("ended", Boolean.TRUE.equals(result.get("reached")) ? "state reached" :
            finished ? "frame-clock deadline" : "wall backstop");
        result.put("framesRequired", frames);
        result.put("timelineMsRequired", timelineMs);
        result.put("wallMs", (System.nanoTime() - started) / 1_000_000);
        return result;
    }

    private static String positiveTwin(String name) {
        if (name.equals("reduced motion keeps the authored poster and never runs the intro"))
            return "imagesequence intro plays once then the declared range scrubs";
        if (name.equals("without Promise the enhancement modules stay inert"))
            return "with Promise the same isolated page enhances (positive twin)";
        if (name.contains("assertions require the module — disabled-module control"))
            return name.replace("assertions require the module — disabled-module control", "plays verbatim in a real page");
        return null;
    }

    private static boolean selected(String name) {
        if (nameFilter == null || name.contains(nameFilter)) return true;
        for (String negative : List.of("without Promise the enhancement modules stay inert",
                "reduced motion keeps the authored poster and never runs the intro")) {
            if (negative.contains(nameFilter) && name.equals(positiveTwin(negative))) return true;
        }
        return name.startsWith("documented example") && name.endsWith("plays verbatim in a real page") &&
            name.replace("plays verbatim in a real page", "assertions require the module — disabled-module control").contains(nameFilter);
    }

    private static void requirePositiveTwin(String engine, String name) {
        String twin = positiveTwin(name);
        if (twin == null) return;
        active(RESULTS.stream().anyMatch(result -> engine.equals(result.get("browser")) &&
            twin.equals(result.get("name")) && Boolean.TRUE.equals(result.get("passed")) &&
            result.get("positiveControls") instanceof List<?> list && !list.isEmpty()),
            "the same-engine positive twin passed: " + twin);
    }

    // Every /js/ script src the example pages and the check pages below
    // declare. The fixture identity endpoint digests the file each of
    // these requests serves; this list is the checker's own copy of that
    // set — a fixture must report on all of them, not on a selection it
    // prefers. serve-examples.test.cjs keeps it equal to the declared srcs.
    private static final List<String> IDENTITY_PATHS = List.of(
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js",
        "/js/paste/oop.js", "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
        "/js/paste/polyfills/getcomputedstyle.js",
        "/js/paste/ui/utilities/animation-frame.js",
        "/js/paste/ui/utilities/scrollrange.js",
        "/js/paste/ui/utilities/imageresolution.js",
        "/js/paste/ui/utilities/mediaquery.js",
        "/js/paste/ui/heroscroll.js",
        "/js/paste/ui/stickynav.js",
        "/js/paste/ui/scrollscrub.js",
        "/js/paste/ui/progressiveresolution.js",
        "/js/paste/ui/imagesequence.js",
        "/js/paste/ui/smoothscroll.js",
        "/js/paste/ui/multistate.js",
        "/js/paste/ui/autogrow.js",
        "/js/paste/io.js", "/js/paste/ui/form.js", "/js/paste/ui/scrollspy.js");

    // Where the runner's own checkout says a served URL lives — the same
    // mapping serve-examples.cjs applies: enhancement modules come from
    // this repository's modules/<name>/<name>.js, the paste.ui.utilities
    // modules from modules/utilities/<name>/<name>.js; the rest of
    // /js/paste/ resolves inside the supplied paste core tree.
    private static Path servedLocalFile(String urlPath) {
        if (urlPath.startsWith("/js/paste/ui/")) {
            String basename = urlPath.substring(urlPath.lastIndexOf('/') + 1, urlPath.length() - ".js".length());
            Path root = Path.of("modules").toAbsolutePath().normalize();
            Path tier = urlPath.startsWith("/js/paste/ui/utilities/") ? root.resolve("utilities") : root;
            Path resolved = tier.resolve(basename).resolve(basename + ".js").normalize();
            require(resolved.startsWith(root), "module path escapes the modules tree: " + urlPath);
            return resolved;
        }
        if (urlPath.startsWith("/js/paste/")) {
            String core = System.getenv("PASTE_CORE_JS");
            require(core != null && !core.isBlank(), "PASTE_CORE_JS is required to bind the fixture's served bytes to a checkout");
            Path root = Path.of(core).toAbsolutePath().normalize();
            Path resolved = root.resolve(urlPath.substring("/js/paste/".length())).normalize();
            require(resolved.startsWith(root), "module path escapes the paste core tree: " + urlPath);
            return resolved;
        }
        throw new IllegalArgumentException("not a served module path: " + urlPath);
    }

    private static String sha256Hex(Path file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] hash = digest.digest(Files.readAllBytes(file));
        StringBuilder hex = new StringBuilder(hash.length * 2);
        for (byte b : hash) hex.append(Character.forDigit((b >> 4) & 15, 16)).append(Character.forDigit(b & 15, 16));
        return hex.toString();
    }

    // The run's first verdict, recorded before any browser launches: the
    // answering fixture carries this run's nonce (when the runner spawned
    // it) and serves exactly this checkout's module bytes. A fixture that
    // fails here cannot produce valid browser evidence for this source —
    // the run continues only so each scenario's own record shows what the
    // wrong bytes would have reported.
    private static void verifyFixtureIdentity() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("browser", "fixture");
        result.put("name", "the fixture host serves this run's identified source bytes");
        Map<String, Object> evidence = new LinkedHashMap<>();
        result.put("evidence", evidence);
        evidence.put("baseUrl", url);
        try {
            String host = URI.create(url).getHost();
            require("localhost".equals(host) || "127.0.0.1".equals(host) || "::1".equals(host) || "[::1]".equals(host),
                "fixture URL is not loopback — this fixture binds loopback only");
            HttpResponse<String> response = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5)).build()
                .send(HttpRequest.newBuilder(URI.create(url + "fixture-identity"))
                    .timeout(Duration.ofSeconds(5)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            require(response.statusCode() == 200,
                "the fixture has no identity response (status " + response.statusCode() + ") — it is not the current fixture or not the fixture at all");
            Map<?, ?> identity = new Gson().fromJson(response.body(), Map.class);
            require(identity != null && "paste-elements serve-examples.cjs".equals(identity.get("fixture")),
                "the answering service is not this repository's fixture host");
            Object nonce = identity.get("nonce");
            evidence.put("reportedNonce", nonce);
            evidence.put("reportedPort", identity.get("port"));
            String expectedNonce = System.getenv("ELEMENTS_FIXTURE_NONCE");
            if (expectedNonce != null && !expectedNonce.isBlank()) {
                require(expectedNonce.equals(nonce),
                    "the answering fixture is not the process this run spawned (nonce mismatch)");
                evidence.put("nonceVerified", true);
            } else {
                evidence.put("nonceVerified", false);
                evidence.put("externalFixture", System.getenv("ELEMENTS_EXTERNAL_FIXTURE") != null);
            }
            Object digestsObj = identity.get("digests");
            require(digestsObj instanceof Map, "the identity response carries no module digests");
            Map<?, ?> digests = (Map<?, ?>) digestsObj;
            List<Map<String, Object>> checks = new ArrayList<>();
            for (String requestPath : IDENTITY_PATHS) {
                Object served = digests.get(requestPath);
                Path local = servedLocalFile(requestPath);
                String localDigest = Files.isRegularFile(local) ? sha256Hex(local) : null;
                boolean ok = served != null && served.equals(localDigest);
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("path", requestPath);
                entry.put("servedDigest", served);
                entry.put("localDigest", localDigest);
                entry.put("ok", ok);
                checks.add(entry);
                require(ok, "served bytes differ from this checkout for " + requestPath
                    + " (served=" + served + ", local=" + localDigest + ")");
            }
            evidence.put("digests", checks);
            result.put("passed", true);
            result.put("pageErrors", List.of());
            System.out.println("PASS fixture identity (nonceVerified=" + evidence.get("nonceVerified") + ")");
        } catch (Throwable error) {
            result.put("passed", false);
            result.put("failure", error.toString());
            System.err.println("FAIL fixture identity\n" + error);
        }
        RESULTS.add(result);
    }

    // The fixture's own PNGs come from serve-examples.cjs; routed external
    // image hosts need an equivalent real, decodable PNG generated here.
    private static byte[] png(int width, int height, int seed) throws Exception {
        BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y += 1) {
            for (int x = 0; x < width; x += 1) {
                image.setRGB(x, y,
                    (((x * 4 + seed * 37) % 256) << 16) |
                    (((y * 4 + seed * 53) % 256) << 8) |
                    (((x + y) * 2 + seed * 91) % 256));
            }
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        ImageIO.write(image, "png", bytes);
        return bytes.toByteArray();
    }

    private static double property(Page page, String selector) {
        return ((Number) page.evaluate(
            "s => parseFloat(getComputedStyle(document.querySelector(s)).getPropertyValue('--paste-scrub-progress') || '0')",
            selector)).doubleValue();
    }

    private static void scrollTo(Page page, double fraction) {
        page.evaluate("f => window.scrollTo(0, (document.documentElement.scrollHeight - innerHeight) * f)", fraction);
    }

    // Scrolls to a fraction of a declaration's own range. Progress 0 is
    // where the subject anchor the scrub-start names (top, center or
    // bottom of the subject's box) meets its viewport anchor (top, center
    // or bottom of the viewport), progress 1 the same for scrub-end —
    // which is also the deepest offset that still holds the scope inside
    // the near band. Scrolling further (the document's own bottom) pushes
    // the subject out of the band and the module correctly releases the
    // landed work. Any other anchor token fails the check rather than
    // standing in for one of these.
    private static void scrollToRangeFraction(Page page, String scopeSelector, double fraction) {
        page.evaluate(
            "([s, f]) => { const el = (s && document.querySelector(s)) || document.querySelector('[data-paste-scrollscrub]');" +
            " const named = el.getAttribute('data-scrub-subject');" +
            " const subject = named ? document.querySelector(named) : el;" +
            " const rect = subject.getBoundingClientRect();" +
            " const at = (token, top, height, what) => {" +
            "   if (token === 'top') return top;" +
            "   if (token === 'center') return top + height / 2;" +
            "   if (token === 'bottom') return top + height;" +
            "   throw new Error('unknown ' + what + ' anchor: ' + token); };" +
            " const edge = (text, fallback) => { const p = (text || fallback).trim().split(/\\s+/);" +
            "   if (p.length !== 2) throw new Error('a scrub edge names two anchors: ' + (text || fallback));" +
            "   return at(p[0], rect.top, rect.height, 'subject') + window.scrollY - at(p[1], 0, window.innerHeight, 'viewport'); };" +
            " const start = edge(el.getAttribute('data-scrub-start'), 'top bottom');" +
            " const end = edge(el.getAttribute('data-scrub-end'), 'bottom top');" +
            " window.scrollTo(0, start + (end - start) * f); }",
            List.of(scopeSelector == null || "null".equals(scopeSelector) ? "" : scopeSelector, fraction));
    }

    private static void scrollToRangeEnd(Page page, String scopeSelector) {
        scrollToRangeFraction(page, scopeSelector, 1);
    }

    // The id a documented example's intro skip control carries, or null
    // when the example declares no intro skip.
    private static String skipIdOf(String markup) {
        Matcher skip = Pattern.compile("data-sequence-intro-skip=\"#([^\"]+)\"").matcher(markup);
        return skip.find() ? skip.group(1) : null;
    }

    // Every source a documented catalog declares, frames and upgrades.
    private static List<String> declaredSourcesOf(String markup) {
        List<String> declared = new ArrayList<>();
        Matcher srcs = Pattern.compile("\"src\":\\s*\"([^\"]+)\"").matcher(markup);
        while (srcs.find()) declared.add(srcs.group(1));
        return declared;
    }

    // Routes one documented example: its page at pagePath, every declared
    // image source to real decodable PNG bytes (recorded in requests), and
    // anything the documentation did not declare fails closed with 404.
    private static void collectImageSizes(JsonElement value, Map<String, int[]> sizes) {
        if (value.isJsonArray()) {
            for (JsonElement child : value.getAsJsonArray()) collectImageSizes(child, sizes);
        } else if (value.isJsonObject()) {
            var object = value.getAsJsonObject();
            if (object.has("src") && object.has("width") && object.has("height")) {
                sizes.put(object.get("src").getAsString(),
                    new int[]{object.get("width").getAsInt(), object.get("height").getAsInt()});
            }
            for (var entry : object.entrySet()) collectImageSizes(entry.getValue(), sizes);
        }
    }

    private static void routeDocumentedExample(BrowserContext context, String pagePath, String markup,
                                               List<String> declaredSources, List<String> requests) {
        Map<String, int[]> sizes = new LinkedHashMap<>();
        Matcher catalog = Pattern.compile("(?s)<script[^>]*type=\"application/json\"[^>]*>(.*?)</script>").matcher(markup);
        require(catalog.find(), "documented example must contain its catalog");
        collectImageSizes(JsonParser.parseString(catalog.group(1)), sizes);
        context.route("**/" + pagePath, route ->
            route.fulfill(new Route.FulfillOptions()
                .setContentType("text/html; charset=utf-8")
                .setBody(verbatimExamplePage(markup))));
        context.route(requestUrl ->
                requestUrl.contains(".webp") || requestUrl.contains(".png"), route -> {
            String requestUrl = route.request().url();
            boolean declared = declaredSources.stream().anyMatch(requestUrl::endsWith);
            if (!declared) {
                route.fulfill(new Route.FulfillOptions().setStatus(404));
                return;
            }
            requests.add(requestUrl);
            try {
                route.fulfill(new Route.FulfillOptions()
                    .setContentType("image/png")
                    .setBodyBytes(png(
                        sizes.entrySet().stream().filter(entry -> requestUrl.endsWith(entry.getKey())).findFirst().orElseThrow().getValue()[0],
                        sizes.entrySet().stream().filter(entry -> requestUrl.endsWith(entry.getKey())).findFirst().orElseThrow().getValue()[1], 17)));
            } catch (Exception error) {
                route.abort();
            }
        });
    }

    // The scope the host's sequence measures — its explicit
    // data-sequence-scrub reference, else the nearest ancestor-or-self
    // declaration, which is the module's own default resolution.
    private static String scopeSelectorEvaluation() {
        return "() => { const h = document.querySelector('[data-paste-imagesequence]');" +
            " const declared = h.getAttribute('data-sequence-scrub');" +
            " const scope = declared ? document.querySelector(declared)" +
            "     : h.closest('[data-paste-scrollscrub]');" +
            " return scope && scope.id ? '#' + scope.id : null; }";
    }

    private static int paintedFrameIndex(Page page, String hostSelector) {
        Object found = page.evaluate(
            "s => { const u = getComputedStyle(document.querySelector(s)).backgroundImage;" +
            "       const m = /frame-(\\d+)\\.png/.exec(u); return m ? Number(m[1]) : -1; }",
            hostSelector);
        return ((Number) found).intValue();
    }

    // A declaration's expected frame: the module maps measured progress
    // onto [from, to] by floor(progress * count), clamped to count - 1.
    private static int expectedIndex(int from, int to, double progress) {
        int count = Math.abs(to - from) + 1;
        int offset = Math.min(count - 1, (int) Math.floor(progress * count));
        return from + (to >= from ? 1 : -1) * offset;
    }

    private static void scenario(Browser browser, String engine, String name,
                                 Map<String, Object> contextOptions,
                                 Consumer<BrowserContext> contextSetup, Check check) {
        if (!selected(name)) return;
        SELECTED_BY_BROWSER.merge(engine, 1, Integer::sum);
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("browser", engine);
        result.put("browserVersion", browser.version());
        result.put("name", name);
        assertions = new ArrayList<>();
        controls = new ArrayList<>();
        result.put("regressionAssertions", assertions);
        result.put("positiveControls", controls);
        List<String> errors = new ArrayList<>();
        List<String> fixtureFailures = new ArrayList<>();
        Map<String, Object> evidence = new LinkedHashMap<>();
        result.put("evidence", evidence);
        long start = System.nanoTime();
        Browser.NewContextOptions options = new Browser.NewContextOptions()
            .setViewportSize(1280, 900);
        if (contextOptions != null) {
            if (contextOptions.containsKey("deviceScaleFactor")) {
                options.setDeviceScaleFactor(((Number) contextOptions.get("deviceScaleFactor")).doubleValue());
            }
            if (contextOptions.containsKey("reducedMotion")) {
                options.setReducedMotion((ReducedMotion) contextOptions.get("reducedMotion"));
            }
            if (contextOptions.containsKey("hasTouch")) {
                options.setHasTouch((Boolean) contextOptions.get("hasTouch"));
            }
            if (contextOptions.containsKey("viewport")) {
                int[] viewport = (int[]) contextOptions.get("viewport");
                options.setViewportSize(viewport[0], viewport[1]);
            }
        }
        try (BrowserContext context = browser.newContext(options)) {
            Page page = context.newPage();
            page.setDefaultTimeout(8000);
            page.onPageError(errors::add);
            page.onResponse(response -> {
                if (response.url().startsWith(url) && !response.ok()) {
                    fixtureFailures.add(response.status() + " " + response.url());
                }
            });
            if (contextSetup != null) contextSetup.accept(context);
            String disabled = System.getenv("ELEMENTS_DISABLE_MODULE");
            if (disabled != null && !disabled.isBlank()) {
                require(disabled.matches("[a-z][a-z-]*"), "invalid disabled module name");
                context.route("**/js/paste/ui/" + disabled + ".js", route ->
                    route.fulfill(new Route.FulfillOptions().setContentType("text/javascript").setBody("")));
                evidence.put("disabledModule", disabled);
            }
            try { check.run(page, evidence); }
            finally { verifyPageDependencies(page); }
            requirePositiveTwin(engine, name);
            boolean asserted = !assertions.isEmpty();
            require(asserted, "scenario must name a regression assertion");
            require(!controls.isEmpty(), "scenario must prove enhancement activity with a positive control");
            page.waitForTimeout(80);
            require(errors.isEmpty(), "uncaught page errors: " + errors);
            require(fixtureFailures.isEmpty(), "fixture 4xx/5xx on declared assets: " + fixtureFailures);
            result.put("passed", true);
            result.put("pageErrors", errors);
            System.out.println("PASS " + engine + " " + name);
        } catch (Throwable error) {
            result.put("passed", false);
            result.put("failure", error.toString());
            result.put("pageErrors", errors);
            result.put("fixtureFailures", fixtureFailures);
            System.err.println("FAIL " + engine + " " + name + "\n" + error);
        }
        result.put("elapsedMs", (System.nanoTime() - start) / 1_000_000);
        RESULTS.add(result);
        assertions = null;
        controls = null;
    }

    private static void scenario(Browser browser, String engine, String name,
                                 Map<String, Object> contextOptions, Check check) {
        scenario(browser, engine, name, contextOptions, null, check);
    }

    // Resolve the complete define graph from the scripts the page actually
    // declares. Missing dependencies must fail even when a negative assertion
    // would otherwise pass because its enhancement never activated.
    private static void verifyPageDependencies(Page page) throws Exception {
        @SuppressWarnings("unchecked")
        List<String> scripts = (List<String>) page.evaluate(
            "() => Array.from(document.scripts, s => s.src).filter(Boolean)");
        Map<String, List<String>> definitions = new LinkedHashMap<>();
        Pattern define = Pattern.compile("paste(?:\\.define|\\['define'\\])\\s*\\(\\s*['\"]([^'\"]+)['\"]\\s*,\\s*(?:\\[([^\\]]*)\\]|function\\b)", Pattern.DOTALL);
        Pattern quoted = Pattern.compile("['\"]([^'\"]+)['\"]");
        for (String script : scripts) {
            String requestPath = URI.create(script).getPath();
            if (!requestPath.startsWith("/js/")) continue;
            Matcher found = define.matcher(Files.readString(servedLocalFile(requestPath)));
            while (found.find()) {
                List<String> deps = new ArrayList<>();
                Matcher dep = quoted.matcher(found.group(2) == null ? "" : found.group(2));
                while (dep.find()) deps.add(dep.group(1));
                definitions.put(found.group(1), deps);
            }
        }
        for (var definition : definitions.entrySet()) {
            for (String dependency : definition.getValue()) {
                require(dependency.equals("paste") || definitions.containsKey(dependency),
                    "page is missing define dependency " + dependency + " required by " + definition.getKey());
            }
        }
    }

    // Every @example JSDoc block is executable markup: extract each
    // verbatim (stripping only the comment prefix), serve it as a real
    // page, and route its documented image hosts to generated PNG bytes
    // so the documented declarations actually paint. Extraction keeps
    // every line from the first markup tag through the last </script> —
    // the catalog's JSON body lines travel with it.
    private static List<String> documentedExampleMarkups() throws Exception {
        String source = Files.readString(Path.of("modules/imagesequence/imagesequence.js"));
        Matcher tags = Pattern.compile("(?m)^ \\* @example$").matcher(source);
        Pattern commentLine = Pattern.compile("^ \\* ?(.*)$");
        List<String> markups = new ArrayList<>();
        while (tags.find()) {
            StringBuilder markup = new StringBuilder();
            boolean inside = false;
            int cursor = tags.end();
            if (cursor < source.length() && source.charAt(cursor) == '\n') cursor += 1;
            for (String line : source.substring(cursor).split("\n", -1)) {
                Matcher comment = commentLine.matcher(line);
                if (!comment.matches()) break;
                String stripped = comment.group(1);
                if (!inside && stripped.stripLeading().startsWith("<")) inside = true;
                if (inside) markup.append(stripped).append('\n');
                if (inside && stripped.contains("</script>")) break;
            }
            String text = markup.toString();
            if (text.contains("<script") && text.contains("</script>")) {
                markups.add(text);
            }
        }
        require(!markups.isEmpty(), "the module's @example blocks did not extract");
        return markups;
    }

    // The catalog's top-level frame base URLs in declared order. Frame
    // objects sit at depth 2 inside the "frames" array — their "src" keys
    // open there too, while upgrade rungs nest one level deeper, so the
    // depth counter keeps them out and index n is catalog index n.
    private static List<String> declaredFrameSources(String markup) {
        List<String> sources = new ArrayList<>();
        int open = markup.indexOf("\"frames\"");
        int depth = 0;
        Pattern srcKey = Pattern.compile("\\G\"src\"\\s*:\\s*\"([^\"]+)\"");
        for (int i = open < 0 ? markup.length() : open; i < markup.length(); i += 1) {
            char c = markup.charAt(i);
            if (c == '[' || c == '{') depth += 1;
            if (c == ']' || c == '}') depth -= 1;
            if (depth == 2 && c == '"') {
                Matcher src = srcKey.matcher(markup.substring(i));
                if (src.lookingAt()) {
                    sources.add(src.group(1));
                    i += src.end() - 1;
                }
            }
        }
        return sources;
    }

    // The URL fragment that identifies one catalog frame however it was
    // served — 'product-0-640.webp' and its upgrade 'product-0-1280.webp'
    // both contain 'product-0-'.
    private static String frameToken(String frameSrc) {
        String basename = frameSrc.substring(frameSrc.lastIndexOf('/') + 1);
        return basename.replaceAll("-\\d+\\.\\w+$", "-");
    }

    private static String paintedEvaluation() {
        return "() => { const h = document.querySelector('[data-paste-imagesequence]');" +
            " return h.tagName === 'IMG' ? (h.currentSrc || h.src) : getComputedStyle(h).backgroundImage; }";
    }

    private static String verbatimExamplePage(String markup) {
        StringBuilder scripts = new StringBuilder();
        for (String src : new String[]{
                "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
                "/js/paste/ui/utilities/animation-frame.js",
                "/js/paste/ui/utilities/scrollrange.js",
                "/js/paste/ui/utilities/imageresolution.js",
                "/js/paste/ui/utilities/mediaquery.js",
                "/js/paste/ui/scrollscrub.js",
                "/js/paste/ui/imagesequence.js"}) {
            scripts.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<style>body{min-height:300vh;margin:0}[data-paste-scrollscrub]{margin-top:120vh;min-height:80vh}" +
            // The module's own stylesheet ships exactly this block-host
            // baseline; inline hosts like <i> need it to measure at all.
            "[data-paste-imagesequence]:not(img){display:block;height:50vh}" +
            "#assembly img{display:block;width:640px;height:360px}</style></head>" +
            "<body>" + markup + scripts + "</body></html>";
    }

    // The missing-Promise fixture: ordinary authored markup with every
    // declared asset routed to real PNG bytes, so a request means the module
    // actually ran. The baseline background and src are the presentation the
    // modules must leave alone.
    private static String noPromisePage() {
        StringBuilder scripts = new StringBuilder();
        for (String src : new String[]{
                "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
                "/js/paste/ui/utilities/animation-frame.js",
                "/js/paste/ui/utilities/scrollrange.js",
                "/js/paste/ui/utilities/imageresolution.js",
                "/js/paste/ui/utilities/mediaquery.js",
                "/js/paste/ui/scrollscrub.js",
                "/js/paste/ui/progressiveresolution.js",
                "/js/paste/ui/imagesequence.js"}) {
            scripts.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<style>body{min-height:300vh;margin:0}" +
            "[data-paste-scrollscrub]{margin-top:120vh;min-height:80vh}" +
            "#np-host{display:block;height:50vh;background-image:url('/np/baseline.png');background-size:cover}" +
            "#np-avatar{display:block;width:240px;height:240px}</style></head><body>" +
            "<section id=\"np-hero\" data-paste-scrollscrub" +
            " data-scrub-start=\"top bottom\" data-scrub-end=\"bottom top\">" +
            "<i id=\"np-host\" data-paste-imagesequence=\"#np-frames\"" +
            " data-sequence-from=\"0\" data-sequence-to=\"2\" aria-hidden=\"true\"></i>" +
            "<button id=\"np-skip\" type=\"button\" hidden>Skip animation</button></section>" +
            "<img id=\"np-avatar\" src=\"/np/avatar-r0.png\" width=\"240\" height=\"240\"" +
            " alt=\"catalog avatar\" data-paste-progressiveresolution data-image-sources=\"#np-avatar-sources\">" +
            "<script type=\"application/json\" id=\"np-frames\">" +
            "{\"frames\":[" +
            "{\"src\":\"/np/frame-0.png\",\"width\":640,\"height\":360}," +
            "{\"src\":\"/np/frame-1.png\",\"width\":640,\"height\":360}," +
            "{\"src\":\"/np/frame-2.png\",\"width\":640,\"height\":360}]}</script>" +
            "<script type=\"application/json\" id=\"np-avatar-sources\">" +
            "{\"src\":\"/np/avatar-r0.png\",\"width\":240,\"height\":240," +
            "\"upgrades\":[{\"src\":\"/np/avatar-r1.png\",\"width\":480,\"height\":480}]}</script>" +
            scripts + "</body></html>";
    }

    // The DPR-1 fixture: one unsized img (no width/height attributes; CSS
    // sets 300px) whose ladder has no rung at the painted width.
    private static String dprOnePage() {
        StringBuilder scripts = new StringBuilder();
        for (String src : new String[]{
                "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
                "/js/paste/ui/utilities/animation-frame.js",
                "/js/paste/ui/utilities/scrollrange.js",
                "/js/paste/ui/utilities/imageresolution.js",
                "/js/paste/ui/utilities/mediaquery.js",
                "/js/paste/ui/progressiveresolution.js"}) {
            scripts.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        return "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
            "<style>body{margin:0}#unsized{display:block;width:300px}</style></head><body>" +
            "<img id=\"unsized\" src=\"/dpr1/base.png\" alt=\"unsized catalog image\"" +
            " data-paste-progressiveresolution data-image-sources=\"#unsized-sources\">" +
            "<script type=\"application/json\" id=\"unsized-sources\">" +
            "{\"src\":\"/dpr1/base.png\",\"width\":240,\"height\":180," +
            "\"upgrades\":[{\"src\":\"/dpr1/up-480.png\",\"width\":480,\"height\":360}," +
            "{\"src\":\"/dpr1/up-960.png\",\"width\":960,\"height\":720}]}</script>" +
            scripts + "</body></html>";
    }

    // Each module's full define chain, in load order, for the regression
    // pages below.
    private static final String[] STICKYNAV_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
        "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
        "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/stickynav.js"};
    private static final String[] SMOOTHSCROLL_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
        "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/ui/smoothscroll.js"};
    private static final String[] HEROSCROLL_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
        "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
        "/js/paste/polyfills/getcomputedstyle.js",
        "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/mediaquery.js",
        "/js/paste/ui/heroscroll.js"};
    private static final String[] RESOLUTION_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
        "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/imageresolution.js",
        "/js/paste/ui/utilities/mediaquery.js", "/js/paste/ui/progressiveresolution.js"};
    private static final String[] SEQUENCE_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
        "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/scrollrange.js",
        "/js/paste/ui/utilities/imageresolution.js", "/js/paste/ui/utilities/mediaquery.js",
        "/js/paste/ui/scrollscrub.js", "/js/paste/ui/imagesequence.js"};
    private static final String[] MULTISTATE_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
        "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/ui/multistate.js"};
    private static final String[] AUTOGROW_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
        "/js/paste/dom.js", "/js/paste/event.js",
        "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/autogrow.js"};

    // An authored regression page: its style and markup, the module
    // chain it declares, then any page script that must run after the
    // modules bind.
    private static String checkPage(String style, String body, String[] scripts, String after) {
        StringBuilder page = new StringBuilder("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\">")
            .append("<style>body{margin:0;font-family:sans-serif}").append(style).append("</style></head><body>")
            .append(body);
        for (String src : scripts) {
            page.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        if (after != null) page.append("<script>").append(after).append("</script>");
        return page.append("</body></html>").toString();
    }

    private static final Map<String, byte[]> SIZED_PNGS = new java.util.concurrent.ConcurrentHashMap<>();
    private static final Pattern SIZED_PNG = Pattern.compile("-(\\d+)x(\\d+)\\.png$");

    // Serves one regression page at checks/<pagePath>, and every image
    // under checks/ whose name ends -<width>x<height>.png as a real PNG of
    // exactly that size (recorded in requests); anything else under
    // checks/ answers 404.
    private static void routeCheckPage(BrowserContext context, String pagePath, String html, List<String> requests) {
        String pageUrl = url + "checks/" + pagePath;
        context.route(requestUrl -> requestUrl.startsWith(url + "checks/"), route -> {
            String requestUrl = route.request().url();
            if (requestUrl.equals(pageUrl)) {
                route.fulfill(new Route.FulfillOptions().setContentType("text/html; charset=utf-8").setBody(html));
                return;
            }
            String path = URI.create(requestUrl).getPath();
            Matcher size = SIZED_PNG.matcher(path);
            if (!size.find()) {
                route.fulfill(new Route.FulfillOptions().setStatus(404));
                return;
            }
            if (requests != null) requests.add(requestUrl);
            try {
                byte[] body = SIZED_PNGS.computeIfAbsent(path, key -> {
                    try {
                        return png(Integer.parseInt(size.group(1)), Integer.parseInt(size.group(2)), key.length());
                    } catch (Exception error) {
                        throw new IllegalStateException(error);
                    }
                });
                route.fulfill(new Route.FulfillOptions().setContentType("image/png").setBodyBytes(body));
            } catch (Exception error) {
                route.abort();
            }
        });
    }

    private static void openCheckPage(Page page, String pagePath) {
        Response navigation = page.navigate(url + "checks/" + pagePath,
            new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
        require(navigation != null && navigation.ok(), "regression page " + pagePath + " loads");
    }

    // Two animation frames and a task: every module pass armed by what
    // happened before has run.
    private static void frames(Page page) {
        page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))");
    }

    private static boolean stuck(Page page) {
        return (Boolean) page.evaluate("() => document.documentElement.classList.contains('paste-fixed-subnav')");
    }

    // A frame catalog under checks/: frame i of name is
    // <name>-frame-<i>-<width>x<height>.png, with one sharper rung when
    // upWidth is positive.
    private static String catalogJson(String name, int count, int width, int height, int upWidth, int upHeight) {
        StringBuilder json = new StringBuilder("{\"frames\":[");
        for (int index = 0; index < count; index += 1) {
            if (index > 0) json.append(',');
            json.append("{\"src\":\"/checks/").append(name).append("-frame-").append(index).append('-')
                .append(width).append('x').append(height).append(".png\",\"width\":").append(width)
                .append(",\"height\":").append(height);
            if (upWidth > 0) {
                json.append(",\"upgrades\":[{\"src\":\"/checks/").append(name).append("-frame-").append(index).append('-')
                    .append(upWidth).append('x').append(upHeight).append(".png\",\"width\":").append(upWidth)
                    .append(",\"height\":").append(upHeight).append("}]");
            }
            json.append('}');
        }
        return json.append("]}").toString();
    }

    // The previous-sibling kinds that have no in-flow box of their own.
    private static final List<Map.Entry<String, String>> BOXLESS_SIBLINGS = List.of(
        Map.entry("script", "<script>window.boxlessSibling = 1;</script>"),
        Map.entry("hidden", "<div hidden>dismissed banner</div>"),
        Map.entry("display:contents", "<div style=\"display:contents\"><span>inline bits</span></div>"),
        Map.entry("position:fixed", "<div style=\"position:fixed;top:0;right:0;width:10px;height:10px\"></div>"));

    private static String multistatePage(String extraBody, String after) {
        return checkPage("[data-multistate-value]{display:none}[data-multistate-state]{display:block}",
            "<input id=\"ms-a1a\" type=\"radio\" data-multistate-key=\"area1\" value=\"a\" checked><label for=\"ms-a1a\">A</label>" +
            "<input id=\"ms-a1b\" type=\"radio\" data-multistate-key=\"area1\" value=\"b\"><label for=\"ms-a1b\">B</label>" +
            "<div data-multistate-key=\"area1\" data-multistate-value=\"a\">area 1 panel a</div>" +
            "<div data-multistate-key=\"area1\" data-multistate-value=\"b\">area 1 panel b</div>" +
            "<input id=\"ms-a2a\" type=\"radio\" data-multistate-key=\"area2\" value=\"a\"><label for=\"ms-a2a\">A</label>" +
            "<input id=\"ms-a2b\" type=\"radio\" data-multistate-key=\"area2\" value=\"b\" checked><label for=\"ms-a2b\">B</label>" +
            "<div data-multistate-key=\"area2\" data-multistate-value=\"a\">area 2 panel a</div>" +
            "<div data-multistate-key=\"area2\" data-multistate-value=\"b\">area 2 panel b</div>" + extraBody,
            MULTISTATE_SCRIPTS, after);
    }

    private static Map<?, ?> multistateSelection(Page page) {
        return (Map<?, ?>) page.evaluate(
            "() => ({area1: document.querySelector('input[data-multistate-key=area1]:checked')?.value ?? null," +
            " area2: document.querySelector('input[data-multistate-key=area2]:checked')?.value ?? null," +
            " hash: decodeURIComponent(location.hash), href: location.href})");
    }

    // Real-browser regressions for behaviour a fake host cannot show:
    // computed cross-fades, scroll anchoring, boxless layout siblings,
    // touch viewports, base-URL resolution, native lazy loading, nested
    // scrollers, native history and smooth scroll behaviour.
    private static void behaviourRegressions(Browser browser, String engine) {
        scenario(browser, engine, "platform mutation and intersection delivery contracts", null,
            context -> routeCheckPage(context, "observer-parity.html", checkPage(
                "#far{position:absolute;top:4000px;width:20px;height:20px}",
                "<div id=\"parent\"></div><div id=\"far\"></div>", new String[]{}, null), null),
            (page, evidence) -> {
                openCheckPage(page, "observer-parity.html");
                Object mutations = page.evaluate("""
                    async () => {
                      const parent = document.getElementById('parent');
                      const child = document.createElement('div');
                      const seen = [];
                      const observer = new MutationObserver(records => seen.push(records.map(r => [r.type, r.attributeName])));
                      const options = {attributes:true, attributeFilter:['data-src'], childList:true};
                      observer.observe(parent, options); observer.observe(parent, options);
                      parent.setAttribute('data-src', 'a'); parent.setAttribute('alt', 'ignored');
                      parent.appendChild(child); child.setAttribute('data-src', 'descendant');
                      const immediate = seen.length;
                      await Promise.resolve();
                      parent.setAttribute('data-src', 'discard'); observer.disconnect();
                      await Promise.resolve();
                      const afterDisconnect = seen.length;
                      observer.observe(child, {attributeFilter:['data-src']});
                      child.setAttribute('data-src', 'b'); await Promise.resolve();
                      observer.disconnect();
                      const invalid = [{attributeFilter:['data-src']}, {attributeOldValue:true}].map(option => {
                        try { observer.observe(parent, {childList:true, attributes:false, ...option}); return false; }
                        catch (error) { return error instanceof TypeError; }
                      });
                      const connection = [child.isConnected, child.ownerDocument === document];
                      parent.removeChild(child);
                      connection.push(child.isConnected, child.ownerDocument === document);
                      parent.appendChild(child);
                      connection.push(child.isConnected);
                      return {immediate, afterDisconnect, seen, invalid, connection};
                    }
                    """);
                evidence.put("mutations", mutations);
                Map<?, ?> report = (Map<?, ?>) mutations;
                require(new Gson().toJson(report.get("connection")).equals("[true,true,false,true,true]"),
                    "connection follows membership and ownerDocument survives detachment");
                require(new Gson().toJson(report.get("invalid")).equals("[true,true]"),
                    "attribute options cannot accompany explicitly disabled attribute observation");
                active(((List<?>) report.get("seen")).size() == 2, "mutations deliver and observation resumes after disconnect");
                require(((Number) report.get("immediate")).intValue() == 0 &&
                    ((Number) report.get("afterDisconnect")).intValue() == 1, "mutation delivery is asynchronous and disconnect discards pending records");
                require(new Gson().toJson(report.get("seen")).equals("[[[\"attributes\",\"data-src\"],[\"childList\",null]],[[\"attributes\",\"data-src\"]]]"),
                    "filtered mutations must exclude descendant attributes and duplicate observe calls");
                page.evaluate("""
                    () => {
                      window.intersections = [];
                      window.proximity = new IntersectionObserver(entries => intersections.push(entries.map(e => e.isIntersecting)));
                      proximity.observe(document.getElementById('far'));
                      proximity.observe(document.getElementById('far'));
                    }
                    """);
                awaitActive(page, "() => JSON.stringify(intersections) === '[[false]]'");
                page.evaluate("() => document.getElementById('far').style.top = '20px'");
                awaitActive(page, "() => JSON.stringify(intersections) === '[[false],[true]]'");
                page.evaluate("() => { proximity.unobserve(document.getElementById('far')); document.getElementById('far').style.top = '4000px'; }");
                page.waitForTimeout(100);
                require(((Number) page.evaluate("() => intersections.length")).intValue() == 2,
                    "an unobserved target must stop reporting intersections");
                evidence.put("intersections", page.evaluate("() => intersections"));
            });

        scenario(browser, engine, "platform CSS scrolling and image URL reflection", null,
            context -> routeCheckPage(context, "css-parity.html", checkPage(
                "html{scroll-behavior:smooth}body{height:4000px}#scroller{height:100px;overflow:auto;scroll-behavior:smooth}" +
                "#inside{height:2000px}", "<div id=\"scroller\"><div id=\"inside\"></div></div>", new String[]{}, null), null),
            (page, evidence) -> {
                openCheckPage(page, "css-parity.html");
                Map<?, ?> immediate = (Map<?, ?>) page.evaluate("""
                    () => {
                      const box = document.getElementById('scroller');
                      scrollTo(0, 500); box.scrollTop = 500;
                      return {window: scrollY, element: box.scrollTop};
                    }
                    """);
                evidence.put("immediate", immediate);
                require(((Number) immediate.get("window")).doubleValue() < 500 &&
                    ((Number) immediate.get("element")).doubleValue() < 500,
                    "CSS smooth behavior must not be faked as synchronous coordinate assignment");
                awaitActive(page, "() => scrollY === 500 && document.getElementById('scroller').scrollTop === 500");
                Map<?, ?> reflected = (Map<?, ?>) page.evaluate("""
                    () => {
                      const base = document.createElement('base');
                      base.href = new URL('first/', location.href).href; document.head.append(base);
                      const img = document.createElement('img'); img.src = 'frame-1x1.png';
                      const first = img.src; base.href = new URL('second/', location.href).href;
                      return {first, second:img.src, attribute:img.getAttribute('src')};
                    }
                    """);
                evidence.put("reflection", reflected);
                active(String.valueOf(reflected.get("first")).endsWith("/checks/first/frame-1x1.png"), "relative image src reflects the document base");
                require(String.valueOf(reflected.get("second")).endsWith("/checks/second/frame-1x1.png") &&
                    "frame-1x1.png".equals(reflected.get("attribute")), "changing the base updates reflection without changing the authored attribute");
            });

        for (String mode : List.of("auto", "smooth", "reduced")) {
            String behavior = mode.equals("auto") ? "auto" : "smooth";
            scenario(browser, engine, "smoothscroll CSS owns motion and target clearance " + mode,
                Map.of("reducedMotion", mode.equals("reduced") ? ReducedMotion.REDUCE : ReducedMotion.NO_PREFERENCE),
                context -> routeCheckPage(context, "native-scroll-" + mode + ".html", checkPage(
                    "html{scroll-behavior:" + behavior + ";scroll-padding-top:24px}" +
                    "@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}" +
                    ".paste-ui-section-nav{height:48px}#gap{height:1600px}" +
                    "#destination{height:1000px;scroll-margin-top:80px}",
                    "<nav class=\"paste-ui-section-nav\"><a id=\"jump\" href=\"#destination\">Jump</a></nav>" +
                    "<div id=\"gap\"></div><section id=\"destination\">Destination<input id=\"next\" aria-label=\"Next\"></section>",
                    SMOOTHSCROLL_SCRIPTS, null), null),
                (page, evidence) -> {
                    openCheckPage(page, "native-scroll-" + mode + ".html");
                    Map<?, ?> result = (Map<?, ?>) page.evaluate("""
                        () => {
                          const link = document.getElementById('jump');
                          const target = document.getElementById('destination');
                          window.nativeScrollCalls = 0;
                          window.coordinateScrollCalls = 0;
                          window.hashChanges = 0;
                          addEventListener('hashchange', () => hashChanges++);
                          const native = target.scrollIntoView;
                          target.scrollIntoView = function(...args) {
                            nativeScrollCalls++; return native.apply(this, args);
                          };
                          const coordinate = window.scrollTo;
                          window.scrollTo = function(...args) {
                            coordinateScrollCalls++; return coordinate.apply(this, args);
                          };
                          let prevented = null;
                          document.addEventListener('click', e => { prevented = e.defaultPrevented; }, {once:true});
                          // Where the navigation stood when focus arrived:
                          // focus follows the landing, never the click.
                          window.focusArrival = null;
                          target.addEventListener('focus', () => {
                            focusArrival = {hash: location.hash, target: target.matches(':target')};
                          }, {once: true});
                          window.expectedScroll = target.getBoundingClientRect().top + scrollY - 104;
                          window.historyBefore = history.length;
                          // The position as the navigation lands: engines
                          // navigate in the click task or a task later, and
                          // hashchange follows either way. A navigation that
                          // never lands reports after a bounded wait.
                          return new Promise(resolve => {
                            const report = landed => resolve({prevented, landed, expected: expectedScroll,
                              actual: scrollY, hash: location.hash, target: target.matches(':target'),
                              nativeScrollCalls, coordinateScrollCalls});
                            addEventListener('hashchange', () => report(true), {once: true});
                            setTimeout(() => report(false), 3000);
                            link.click();
                          });
                        }
                        """);
                    evidence.put("navigation", result);
                    require(Boolean.FALSE.equals(result.get("prevented")),
                        "the module must leave the click to native fragment navigation");
                    require(Boolean.TRUE.equals(result.get("landed")), "the link navigation must fire hashchange");
                    require("#destination".equals(result.get("hash")) && Boolean.TRUE.equals(result.get("target")),
                        "native navigation must update the address and :target");
                    awaitActive(page, "() => document.activeElement === document.getElementById('destination')");
                    Map<?, ?> arrival = (Map<?, ?>) page.evaluate("() => focusArrival");
                    evidence.put("focusArrival", arrival);
                    require(arrival != null && "#destination".equals(arrival.get("hash")) && Boolean.TRUE.equals(arrival.get("target")),
                        "focus must arrive after the navigation has landed, not inside the click: " + arrival);
                    require(((Number) result.get("nativeScrollCalls")).intValue() == 0,
                        "no JavaScript scroll request may compete with the browser's fragment scroll");
                    double distance = Math.abs(((Number) result.get("expected")).doubleValue() - ((Number) result.get("actual")).doubleValue());
                    require(mode.equals("smooth") ? distance > 100 : distance <= 1,
                        "CSS must choose immediate versus smooth scrolling, including its reduced-motion rule");
                    page.waitForFunction("() => Math.abs(scrollY - expectedScroll) <= 1");
                    require(((Number) page.evaluate("() => coordinateScrollCalls")).intValue() == 0,
                        "JavaScript coordinate writes must not compete with native scrolling");
                    require(((Number) page.evaluate("() => hashChanges")).intValue() == 1,
                        "a link navigation must send hashchange as native fragment navigation does");
                    page.evaluate("() => document.getElementById('jump').click()");
                    require(Boolean.TRUE.equals(page.evaluate("() => history.length === historyBefore + 1")),
                        "repeating a fragment must not duplicate history entries");
                    // Traverse history after the repeated native request has
                    // settled; cancellation during animation is browser-owned.
                    page.waitForTimeout(500);
                    // Text-field focus can natively override scroll restoration
                    // in WebKit, so test history before transferring focus into it.
                    page.evaluate("() => history.back()");
                    page.waitForFunction("() => location.hash === '' && scrollY === 0");
                    evidence.put("afterBack", page.evaluate("() => ({hash:location.hash, y:scrollY, events:hashChanges})"));
                    page.evaluate("() => history.forward()");
                    page.waitForFunction("() => location.hash === '#destination' && Math.abs(scrollY - expectedScroll) <= 1");
                    evidence.put("afterForward", page.evaluate("() => ({hash:location.hash, y:scrollY, events:hashChanges})"));
                    require(((Number) page.evaluate("() => hashChanges")).intValue() == 3,
                        "Back and Forward must retain native fragment history events");
                    page.keyboard().press("Tab");
                    evidence.put("focusAfterTab", page.evaluate("() => document.activeElement.id"));
                    require("next".equals(evidence.get("focusAfterTab")),
                        "keyboard navigation must continue inside the destination");
                    require(Boolean.TRUE.equals(page.evaluate("() => !document.getElementById('destination').hasAttribute('tabindex')")),
                        "temporary focus attributes must leave when focus moves on");

                });
        }

        scenario(browser, engine, "platform ResizeObserver reports sizes, not position or descendants", null,
            context -> routeCheckPage(context, "observer-contract.html", checkPage(
                "#box{position:absolute;width:100px;height:100px;top:0}",
                "<div id=\"box\"></div>", new String[]{}, null), null),
            (page, evidence) -> {
                openCheckPage(page, "observer-contract.html");
                page.evaluate("""
                    () => {
                      window.deliveries = [];
                      window.observer = new ResizeObserver(entries => deliveries.push(entries.map(e => e.target.id)));
                      observer.observe(document.getElementById('box'));
                      observer.observe(document.getElementById('box'));
                    }
                    """);
                awaitActive(page, "() => deliveries.length === 1");
                require(page.evaluate("() => JSON.stringify(deliveries)").equals("[[\"box\"]]"), "duplicate observation delivered twice");
                page.evaluate("""
                    () => {
                      deliveries.length = 0;
                      const box = document.getElementById('box');
                      box.style.top = '200px';
                      const child = document.createElement('div');
                      child.id = 'child'; child.style.height = '20px';
                      box.appendChild(child);
                    }
                    """);
                frames(page);
                require(((Number) page.evaluate("() => deliveries.length")).intValue() == 0,
                    "position and child insertion must not report unchanged parent size");
                page.evaluate("() => document.getElementById('box').style.width = '120px'");
                awaitActive(page, "() => deliveries.length === 1");
                evidence.put("positiveControl", "a real size change reports the watched parent");
                page.evaluate("() => { observer.disconnect(); deliveries.length = 0; observer.observe(document.getElementById('child')); }");
                awaitActive(page, "() => deliveries.length === 1");
                require(page.evaluate("() => JSON.stringify(deliveries)").equals("[[\"child\"]]"), "reobserve retained the old target");
            });

        scenario(browser, engine, "form replaces only its target after a background submit", null,
            context -> {
                routeCheckPage(context, "form-submit.html", checkPage("", 
                    "<p id=\"outside\">Keep this content</p><div id=\"reply\" data-paste-io-reply-fragment-target>" +
                    "<form data-paste-form method=\"post\" action=\"/form-answer\">" +
                    "<input name=\"message\" value=\"hello\"><button name=\"intent\" value=\"save\">Send</button>" +
                    "</form></div>",
                    new String[]{"/js/paste/paste.js", "/js/paste/util.js", "/js/paste/guid.js",
                        "/js/paste/event.js", "/js/paste/io.js", "/js/paste/ui/form.js"}, null), null);
                context.route("**/form-answer", route -> {
                    require("POST".equals(route.request().method()), "the submission must remain POST");
                    require("message=hello&intent=save".equals(route.request().postData()),
                        "the request must include the submitter in form order");
                    route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                        .setBody("<p id=\"answer\">Saved</p>"));
                });
            }, (page, evidence) -> {
                openCheckPage(page, "form-submit.html");
                String before = page.url();
                page.click("button");
                page.waitForSelector("#reply #answer");
                active(page.locator("#reply #answer").count() == 1, "the response appeared inside the declared target");
                require(page.url().equals(before), "background submission navigated the document");
                require(page.locator("#outside").count() == 1, "content outside the target was replaced");
                require(page.locator("#reply[aria-busy=true]").count() == 0, "completed submission remained busy");
                evidence.put("positiveControl", "the response appeared inside the existing target without navigation");
            });

        scenario(browser, engine, "scrollspy moves the active parent as sections cross the nav", null,
            context -> routeCheckPage(context, "scrollspy-active.html", checkPage(
                "nav{position:fixed;top:0;height:40px}section{height:1000px}#lead{height:300px}",
                "<nav data-paste-scrollspy data-spy-touch><ul><li id=\"first-link\"><a href=\"#first\">First</a></li>" +
                "<li id=\"second-link\"><a href=\"#second\">Second</a></li></ul></nav>" +
                "<div id=\"lead\"></div><section id=\"first\">First</section><section id=\"second\">Second</section>",
                new String[]{"/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
                    "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
                    "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/scrollspy.js"}, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrollspy-active.html");
                page.evaluate("() => window.scrollTo(0, 400)");
                awaitActive(page, "() => document.getElementById('first-link').classList.contains('active')");
                page.evaluate("() => window.scrollTo(0, 1350)");
                awaitActive(page, "() => document.getElementById('second-link').classList.contains('active')");
                require(page.locator("li.active").count() == 1, "the old active group was not cleared");
                evidence.put("positiveControl", "both section parents became active in turn");
            });

        // A background-image transition computes a cross-fade between the
        // standing and the next image while it runs; the sequence keeps
        // its claim through it and scrubbing keeps advancing.
        scenario(browser, engine, "imagesequence keeps scrubbing a host with a background-image transition", null,
            context -> routeCheckPage(context, "sequence-transition.html", checkPage(
                ".xf-pad{height:100vh}#xf-band{height:300vh;position:relative}" +
                "#xf-scene{position:sticky;top:0;height:100vh}" +
                "#xf-host{display:block;width:640px;height:360px;background-size:cover;" +
                "background-image:url('/checks/xf-frame-0-320x180.png');transition:all .3s linear}",
                "<div class=\"xf-pad\"></div><section id=\"xf-band\"><div id=\"xf-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#xf-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"xf-host\" data-paste-imagesequence=\"#xf-frames\" data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                "<script type=\"application/json\" id=\"xf-frames\">" + catalogJson("xf", 8, 320, 180, 0, 0) + "</script>" +
                "</div></section><div class=\"xf-pad\"></div>",
                SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-transition.html");
                page.waitForTimeout(400);
                String settled = "() => { const v = getComputedStyle(document.getElementById('xf-host')).backgroundImage;" +
                    " const m = /^url\\(\"?[^\")]*xf-frame-(\\d+)-[^\")]*\"?\\)$/.exec(v); return m ? Number(m[1]) : -1; }";
                List<Map<String, Object>> steps = new ArrayList<>();
                for (double fraction : new double[]{0.3, 0.55, 0.8, 1.0}) {
                    page.evaluate("f => { const b = document.getElementById('xf-band').getBoundingClientRect();" +
                        " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * f); }", fraction);
                    page.waitForTimeout(200);
                    double progress = property(page, "#xf-scene");
                    int expected = expectedIndex(0, 7, progress);
                    Map<String, Object> step = new LinkedHashMap<>();
                    step.put("fraction", fraction);
                    step.put("progress", progress);
                    step.put("expected", expected);
                    steps.add(step);
                    evidence.put("steps", steps);
                    awaitActive(page, "want => (" + settled + ")() === want",
                        expected, new Page.WaitForFunctionOptions().setTimeout(4000));
                    step.put("painted", page.evaluate(settled));
                }
            });

        // The same cross-fade on a progressiveresolution host: the module
        // keeps its claim and still upgrades when the paint size grows.
        List<String> transitionRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution keeps upgrading a host with a background-image transition",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "resolution-transition.html", checkPage(
                "#xr-host{width:640px;height:640px;background-size:cover;" +
                "background-image:url('/checks/xr-base-640x640.png');transition:all .3s linear}",
                "<div id=\"xr-host\" data-paste-progressiveresolution data-image-sources=\"#xr-sources\"></div>" +
                "<script type=\"application/json\" id=\"xr-sources\">{\"src\":\"/checks/xr-base-640x640.png\"," +
                "\"width\":640,\"height\":640,\"upgrades\":[" +
                "{\"src\":\"/checks/xr-up-1280x1280.png\",\"width\":1280,\"height\":1280}," +
                "{\"src\":\"/checks/xr-up-1920x1920.png\",\"width\":1920,\"height\":1920}]}</script>",
                RESOLUTION_SCRIPTS, null), transitionRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-transition.html");
                awaitActive(page, "() => document.getElementById('xr-host').style.backgroundImage.includes('xr-up-1280x1280')");
                page.waitForTimeout(600);
                evidence.put("first", page.evaluate("() => getComputedStyle(document.getElementById('xr-host')).backgroundImage"));
                page.evaluate("() => { const h = document.getElementById('xr-host'); h.style.width = '960px'; h.style.height = '960px'; }");
                awaitActive(page, "() => document.getElementById('xr-host').style.backgroundImage.includes('xr-up-1920x1920')",
                    null, new Page.WaitForFunctionOptions().setTimeout(4000));
                evidence.put("grown", page.evaluate("() => document.getElementById('xr-host').style.backgroundImage"));
                evidence.put("requests", transitionRequests);
            });

        // A previous sibling with no in-flow box of its own must not
        // carry the threshold with the scroll: after a resize deep in the
        // page the nav stays stuck everywhere past its slot.
        for (Map.Entry<String, String> sibling : BOXLESS_SIBLINGS) {
            String pagePath = "sticky-" + sibling.getKey().replaceAll("[^a-z]", "") + ".html";
            scenario(browser, engine, "stickynav stays stuck after a deep resize with a " + sibling.getKey() + " previous sibling",
                Map.of("viewport", new int[]{1200, 800}),
                context -> routeCheckPage(context, pagePath, checkPage(
                    "#_paste_ui_nav_wrap{height:50px;background:#333;color:#fff}.sn-hero{height:600px;background:#88a}" +
                    ".sticky-nav-target{height:40px;background:#eee}" +
                    ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0}" +
                    ".sn-spacer{height:6000px}",
                    "<div id=\"_paste_ui_nav_wrap\">site nav</div><div class=\"sn-hero\">hero</div>" + sibling.getValue() +
                    "<nav class=\"sticky-nav-target\"><a href=\"#sn-a\">A</a></nav><div class=\"sn-spacer\" id=\"sn-a\">content</div>",
                    STICKYNAV_SCRIPTS, null), null),
                (page, evidence) -> {
                    openCheckPage(page, pagePath);
                    frames(page);
                    page.evaluate("() => window.scrollTo(0, 100)");
                    frames(page);
                    require(!stuck(page), "the nav is stuck above its slot");
                    page.evaluate("() => window.scrollTo(0, 2000)");
                    frames(page);
                    active(stuck(page), "the nav did not stick deep in the page");
                    page.setViewportSize(1100, 800);
                    frames(page);
                    frames(page);
                    evidence.put("stuckAfterResize", stuck(page));
                    // The slot's top sits at 650 and the wrap is 50 tall:
                    // 700 is past the true threshold of 600.
                    page.evaluate("() => window.scrollTo(0, 700)");
                    frames(page);
                    boolean stuckJustPast = stuck(page);
                    evidence.put("stuckAt700", stuckJustPast);
                    require(stuckJustPast, "the nav unstuck past its slot after a resize deep in the page");
                    page.evaluate("() => window.scrollTo(0, 100)");
                    frames(page);
                    require(!stuck(page), "the nav stayed stuck above its slot");
                });
        }

        // A transformed previous sibling still anchors the slot: its
        // layout box, not where the transform draws it, is what the slot
        // follows. A vw-sized hero with a compositing hint shrinks across
        // a resize while the nav is stuck; the threshold must shrink with
        // it. An inline svg has no layout offsets; its rect stands in.
        for (String[] hint : new String[][]{
                {"a translateZ(0)", "<div class=\"sn-hero\" style=\"height:50vw;transform:translateZ(0)\">hero</div>"},
                {"a translate", "<div class=\"sn-hero\" style=\"height:50vw;translate:0 0\">hero</div>"},
                {"an inline svg", "<svg class=\"sn-hero\" viewBox=\"0 0 2 1\" style=\"display:block;width:100%\"></svg>"}}) {
            String hintPage = "sticky-hint-" + hint[0].replaceAll("[^a-z]", "") + ".html";
            scenario(browser, engine, "stickynav follows " + hint[0] + " previous sibling across a resize while stuck",
                Map.of("viewport", new int[]{1200, 800}),
                context -> routeCheckPage(context, hintPage, checkPage(
                    "#_paste_ui_nav_wrap{height:50px;background:#333;color:#fff}.sn-hero{background:#88a}" +
                    ".sticky-nav-target{height:40px;background:#eee}" +
                    ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0}" +
                    ".sn-spacer{height:6000px}",
                    "<div id=\"_paste_ui_nav_wrap\">site nav</div>" + hint[1] +
                    "<nav class=\"sticky-nav-target\"><a href=\"#sn-a\">A</a></nav><div class=\"sn-spacer\" id=\"sn-a\">content</div>",
                    STICKYNAV_SCRIPTS, null), null),
                (page, evidence) -> {
                    openCheckPage(page, hintPage);
                    frames(page);
                    page.evaluate("() => window.scrollTo(0, 100)");
                    frames(page);
                    require(!stuck(page), "the nav is stuck above its slot");
                    page.evaluate("() => window.scrollTo(0, 2000)");
                    frames(page);
                    active(stuck(page), "the nav did not stick deep in the page");
                    page.setViewportSize(1000, 800);
                    frames(page);
                    frames(page);
                    // The hero is now 500 tall: the slot's top sits at
                    // 550 and the wrap is 50 tall, so the threshold is
                    // 500, no longer 600.
                    evidence.put("heroAfterResize", page.evaluate("() => document.querySelector('.sn-hero').getBoundingClientRect().height"));
                    page.evaluate("() => window.scrollTo(0, 540)");
                    frames(page);
                    evidence.put("stuckAt540", stuck(page));
                    require(stuck(page), "the nav unstuck past its slot after the sibling above it shrank");
                    page.evaluate("() => window.scrollTo(0, 460)");
                    frames(page);
                    evidence.put("stuckAt460", stuck(page));
                    require(!stuck(page), "the nav stayed stuck above its slot");
                    page.evaluate("() => window.scrollTo(0, 540)");
                    frames(page);
                    require(stuck(page), "the nav did not stick again past its slot");
                });
        }

        // A scroll-linked effect that transforms the previous sibling only
        // once the page has scrolled: the anchor measured in flow and the
        // one measured while stuck must be the same element, or the
        // distance kept between them names the wrong slot.
        scenario(browser, engine, "stickynav keeps its slot when a scroll-linked transform toggles on the previous sibling",
            Map.of("viewport", new int[]{1200, 800}),
            context -> routeCheckPage(context, "sticky-toggled-transform.html", checkPage(
                "#_paste_ui_nav_wrap{height:50px;background:#333;color:#fff}.sn-hero{height:600px;background:#88a}" +
                ".sn-para{height:200px;background:#a88}" +
                ".sticky-nav-target{height:40px;background:#eee}" +
                ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0}" +
                ".sn-spacer{height:6000px}",
                "<div id=\"_paste_ui_nav_wrap\">site nav</div><div class=\"sn-hero\">hero</div>" +
                "<div class=\"sn-para\" id=\"sn-para\">parallax</div>" +
                "<nav class=\"sticky-nav-target\"><a href=\"#sn-a\">A</a></nav><div class=\"sn-spacer\" id=\"sn-a\">content</div>" +
                "<script>addEventListener('scroll', function () { var y = scrollY;" +
                " document.getElementById('sn-para').style.transform = y > 300 ? 'translateY(' + Math.round(y * 0.05) + 'px)' : '';" +
                " }, {passive: true});</script>",
                STICKYNAV_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sticky-toggled-transform.html");
                frames(page);
                page.evaluate("() => window.scrollTo(0, 100)");
                frames(page);
                require(!stuck(page), "the nav is stuck above its slot");
                page.evaluate("() => window.scrollTo(0, 2000)");
                frames(page);
                active(stuck(page), "the nav did not stick deep in the page");
                active(!"".equals(page.evaluate("() => document.getElementById('sn-para').style.transform")),
                    "the scroll-linked effect transformed the sibling");
                page.setViewportSize(1100, 800);
                frames(page);
                frames(page);
                // The slot's top sits at 850 and the wrap is 50 tall:
                // the threshold is 800 at either width.
                page.evaluate("() => window.scrollTo(0, 700)");
                frames(page);
                evidence.put("stuckAt700", stuck(page));
                require(!stuck(page), "the nav stayed stuck above its slot after a resize while the sibling was transformed");
                page.evaluate("() => window.scrollTo(0, 820)");
                frames(page);
                evidence.put("stuckAt820", stuck(page));
                require(stuck(page), "the nav did not stick past its slot");
            });

        // A target with no box (hidden at a breakpoint) has no slot: it
        // must not read as stuck at the top of the page, which would show
        // the stuck-state content there. Once a wider viewport shows the
        // target, the nav sticks at its slot.
        scenario(browser, engine, "stickynav leaves a target hidden at a breakpoint unstuck",
            Map.of("viewport", new int[]{700, 700}),
            context -> routeCheckPage(context, "sticky-hidden-target.html", checkPage(
                ".sn-hero{height:500px;background:#88a}.sticky-nav-target{height:40px;background:#eee}" +
                "@media (max-width:800px){.sticky-nav-target{display:none}}" +
                ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0}" +
                ".sn-spacer{height:6000px}",
                "<div class=\"sn-hero\">hero</div>" +
                "<nav class=\"sticky-nav-target\"><a href=\"#sn-a\">A</a></nav><div class=\"sn-spacer\" id=\"sn-a\">content</div>",
                STICKYNAV_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sticky-hidden-target.html");
                frames(page);
                page.evaluate("() => window.scrollTo(0, 5)");
                frames(page);
                page.evaluate("() => window.scrollTo(0, 6)");
                frames(page);
                evidence.put("stuckHiddenAt6", stuck(page));
                require(!stuck(page), "a target hidden at this width read as stuck near the top of the page");
                page.evaluate("() => window.scrollTo(0, 2000)");
                frames(page);
                require(!stuck(page), "a target hidden at this width read as stuck deep in the page");
                page.evaluate("() => window.scrollTo(0, 6)");
                frames(page);
                page.setViewportSize(1000, 700);
                frames(page);
                frames(page);
                require(!stuck(page), "the shown target stuck above its slot");
                page.evaluate("() => window.scrollTo(0, 520)");
                frames(page);
                evidence.put("stuckShownAt520", stuck(page));
                active(stuck(page), "the shown target did not stick past its slot");
                page.evaluate("() => window.scrollTo(0, 480)");
                frames(page);
                require(!stuck(page), "the shown target stayed stuck above its slot");
            });

        // The stuck threshold names the in-flow slot after a resize while
        // stuck, whatever moved meanwhile: fractional offsets summed over
        // nested wrappers, an ancestor transform that settles or scales,
        // a transformed inline svg above the target, or the only sibling
        // above it hidden at the new width so the parent's content box
        // anchors the slot. The stuck pass is checked on its own: without
        // ResizeObserver, unsticking does not re-measure.
        String snSlotStyle = "#_paste_ui_nav_wrap{height:50px;position:fixed;top:0;left:0;right:0;z-index:9;background:#333}" +
            "#sn-above{height:100px}#sn-hero{height:600px;background:#88a}" +
            ".sticky-nav-target{height:40px;background:#eee;display:block}" +
            ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0}.sn-spacer{height:6000px}";
        String snSlotTail = "<nav class=\"sticky-nav-target\" id=\"sn-t\"><a href=\"#sn-a\">A</a></nav>" +
            "<div class=\"sn-spacer\" id=\"sn-a\">content</div>";
        for (String[] snCase : new String[][]{
                {"nested fractional wrappers",
                    ".sn-r{position:relative;padding-top:0.45px;border-top:0.3px solid transparent}#sn-above{height:100.45px}#sn-hero{height:600.45px}",
                    "<div class=\"sn-r\"><div class=\"sn-r\"><div class=\"sn-r\"><div class=\"sn-r\"><div class=\"sn-r\"><div class=\"sn-r\">" +
                        "<div id=\"sn-hero\">hero</div>" + snSlotTail + "</div></div></div></div></div></div>",
                    "document.getElementById('sn-above').style.height = '250.9px';" +
                        " document.getElementById('sn-hero').style.height = '500.3px';" +
                        " document.querySelectorAll('.sn-r').forEach(function (r) { r.style.paddingTop = '0.9px'; });"},
                {"an ancestor translate that settles", "#sn-w{transform:translateY(80px)}",
                    "<div id=\"sn-w\"><div id=\"sn-hero\">hero</div>" + snSlotTail + "</div>",
                    "document.getElementById('sn-w').style.transform = 'none';" +
                        " document.getElementById('sn-hero').style.height = '500px';"},
                {"a scaled ancestor", "#sn-w{transform:scale(0.8);transform-origin:0 0}",
                    "<div id=\"sn-w\"><div id=\"sn-hero\">hero</div>" + snSlotTail + "</div>",
                    "document.getElementById('sn-above').style.height = '250px';" +
                        " document.getElementById('sn-hero').style.height = '500px';"},
                {"a translated inline svg above", "#sn-svg{display:block;transform:translateY(0)}",
                    "<svg id=\"sn-svg\" width=\"300\" height=\"200\"></svg>" + snSlotTail,
                    "document.getElementById('sn-above').style.height = '750px';" +
                        " document.getElementById('sn-svg').style.transform = 'translateY(-120px)';"},
                {"a bordered parent once the sibling above hides", "#sn-p{position:relative;border-top:13px solid;padding-top:9px}",
                    "<div id=\"sn-p\"><div id=\"sn-hero\">hero</div>" + snSlotTail + "</div>",
                    "document.getElementById('sn-hero').style.display = 'none';" +
                        " document.getElementById('sn-above').style.height = '250px';"},
                {"a table cell once the sibling above hides", "table{border:6px solid;border-spacing:5px}td{border:4px solid;padding:3px}",
                    "<table><tr><td><div id=\"sn-hero\">hero</div>" + snSlotTail + "</td></tr></table>",
                    "document.getElementById('sn-hero').style.display = 'none';" +
                        " document.getElementById('sn-above').style.height = '250px';"}}) {
            String snSlotPage = "sticky-slot-" + snCase[0].replaceAll("[^a-z]", "") + ".html";
            scenario(browser, engine, "stickynav keeps the stuck threshold at the in-flow slot with " + snCase[0],
                Map.of("viewport", new int[]{1200, 800}),
                context -> routeCheckPage(context, snSlotPage, checkPage(snSlotStyle + snCase[1],
                    "<script>window.ResizeObserver = undefined;</script>" +
                    "<div id=\"_paste_ui_nav_wrap\">site nav</div><div id=\"sn-above\">above</div>" + snCase[2] +
                    "<script>window.snMutate = function () { " + snCase[3] + " };</script>",
                    STICKYNAV_SCRIPTS, null), null),
                (page, evidence) -> {
                    openCheckPage(page, snSlotPage);
                    frames(page);
                    page.evaluate("() => window.scrollTo(0, 100)");
                    frames(page);
                    require(!stuck(page), "the nav is stuck above its slot");
                    page.evaluate("() => window.scrollTo(0, 3000)");
                    frames(page);
                    active(stuck(page), "the nav did not stick deep in the page");
                    page.evaluate("() => window.snMutate()");
                    page.setViewportSize(1100, 800);
                    frames(page);
                    frames(page);
                    require(stuck(page), "the resize deep in the page unstuck the nav");
                    // Back at the top the target is in flow: its rect is
                    // the slot the stuck pass had to name.
                    page.evaluate("() => window.scrollTo(0, 0)");
                    frames(page);
                    double slot = ((Number) page.evaluate("() => document.getElementById('sn-t').getBoundingClientRect().top" +
                        " + window.scrollY - 50")).doubleValue();
                    evidence.put("inFlowThreshold", slot);
                    page.evaluate("y => window.scrollTo(0, y)", slot - 1.5);
                    frames(page);
                    evidence.put("stuckJustAbove", stuck(page));
                    require(!stuck(page), "the stuck pass put the threshold above the in-flow slot " + slot);
                    page.evaluate("y => window.scrollTo(0, y)", slot + 1.5);
                    frames(page);
                    evidence.put("stuckJustPast", stuck(page));
                    require(stuck(page), "the stuck pass put the threshold below the in-flow slot " + slot);
                });
        }

        // A target shown after load (a class removed, a tab panel shown)
        // and content inserted above the target after load move the slot
        // with no resize: the nav sticks at the slot as it is now.
        for (String[] snLate : new String[][]{
                {"a target revealed after load", "#sn-t.sn-off{display:none}",
                    "<div id=\"sn-hero\">hero</div><nav class=\"sticky-nav-target sn-off\" id=\"sn-t\"><a href=\"#sn-a\">A</a></nav>",
                    "document.getElementById('sn-t').classList.remove('sn-off');"},
                {"a tab panel shown after load", "#sn-panel{display:none}#sn-panel.sn-on{display:block}",
                    "<div id=\"sn-hero\">hero</div><div id=\"sn-panel\"><div style=\"height:30px\">intro</div>" +
                        "<nav class=\"sticky-nav-target\" id=\"sn-t\"><a href=\"#sn-a\">A</a></nav></div>",
                    "document.getElementById('sn-panel').classList.add('sn-on');"},
                {"content inserted above the target after load", "",
                    "<div id=\"sn-hero\">hero</div>" + snSlotTail,
                    "var d = document.createElement('div'); d.style.height = '200px';" +
                        " document.getElementById('sn-t').parentNode.insertBefore(d, document.getElementById('sn-t'));"},
                {"a display: contents target", ".sticky-nav-target{display:contents}.sticky-nav-target>div{display:block;height:40px}" +
                        ".paste-fixed-subnav .sticky-nav-target>div{position:fixed;top:0;left:0;right:0}",
                    "<div id=\"sn-hero\">hero</div><nav class=\"sticky-nav-target\" id=\"sn-t\"><div id=\"sn-tc\">A</div></nav>", ""}}) {
            String snLatePage = "sticky-late-" + snLate[0].replaceAll("[^a-z]", "") + ".html";
            scenario(browser, engine, "stickynav sticks at the current slot of " + snLate[0],
                Map.of("viewport", new int[]{1200, 800}),
                context -> routeCheckPage(context, snLatePage, checkPage(snSlotStyle + snLate[1],
                    "<div id=\"_paste_ui_nav_wrap\">site nav</div><div id=\"sn-above\">above</div>" + snLate[2] +
                    "<div class=\"sn-spacer\" id=\"sn-a\">content</div>" +
                    "<script>window.snLate = function () { " + snLate[3] + " };</script>",
                    STICKYNAV_SCRIPTS, null), null),
                (page, evidence) -> {
                    openCheckPage(page, snLatePage);
                    frames(page);
                    page.evaluate("() => window.scrollTo(0, 100)");
                    frames(page);
                    page.evaluate("() => window.scrollTo(0, 0)");
                    frames(page);
                    page.evaluate("() => window.snLate()");
                    frames(page);
                    frames(page);
                    double slot = ((Number) page.evaluate("() => { var t = document.getElementById('sn-t');" +
                        " var c = document.getElementById('sn-tc'); return (c || t).getBoundingClientRect().top + window.scrollY - 50; }"))
                        .doubleValue();
                    evidence.put("threshold", slot);
                    active(slot > 600, "the slot is not below the hero: " + slot);
                    page.evaluate("y => window.scrollTo(0, y)", slot - 20);
                    frames(page);
                    evidence.put("stuckAbove", stuck(page));
                    require(!stuck(page), "the nav stuck above its slot " + slot);
                    page.evaluate("y => window.scrollTo(0, y)", slot + 20);
                    frames(page);
                    evidence.put("stuckPast", stuck(page));
                    require(stuck(page), "the nav did not stick past its slot " + slot);
                });
        }

        // Content that grows before the click leaves the landing to the
        // browser and the target's CSS scroll-margin; the module measures
        // nothing and moves focus only once the navigation has landed.
        // There is no promise to chase a target moving during animation.
        scenario(browser, engine, "smoothscroll leaves a grown page's landing to CSS scroll-margin and focuses after the navigation", null,
            context -> routeCheckPage(context, "smoothscroll-shift.html", checkPage(
                "html{scroll-behavior:auto}.paste-ui-section-nav{position:fixed;top:0;height:48px}" +
                "section{height:1000px;scroll-margin-top:96px}",
                "<nav class=\"paste-ui-section-nav\"><a id=\"ss-go\" href=\"#ss-s4\">to s4</a></nav>" +
                "<section id=\"ss-s1\">s1</section><div id=\"ss-slot\"></div>" +
                "<section id=\"ss-s4\">s4</section><section>s5</section>",
                SMOOTHSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "smoothscroll-shift.html");
                page.evaluate("() => { const target = document.getElementById('ss-s4'); window.ssArrival = null;" +
                    " target.addEventListener('focus', () => { ssArrival = {hash: location.hash, target: target.matches(':target')}; }, {once: true});" +
                    " document.getElementById('ss-slot').style.height = '300px'; document.getElementById('ss-go').click(); }");
                awaitActive(page, "() => document.activeElement.id === 'ss-s4' && location.hash === '#ss-s4'");
                Map<?, ?> arrival = (Map<?, ?>) page.evaluate("() => ssArrival");
                evidence.put("focusArrival", arrival);
                require(arrival != null && "#ss-s4".equals(arrival.get("hash")) && Boolean.TRUE.equals(arrival.get("target")),
                    "focus must arrive after the navigation has landed, not inside the click: " + arrival);
                double top = ((Number) page.evaluate("() => document.getElementById('ss-s4').getBoundingClientRect().top")).doubleValue();
                evidence.put("targetTop", top);
                require(Math.abs(top - 96) <= 1, "the target must respect CSS clearance rather than the nav's measured height");
            });

        // A zero background axis paints no image. A visible sibling proves
        // the resolution module is active before the no-upgrade assertion.
        List<String> zeroBackgroundRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution leaves a zero-sized background at its baseline", null,
            context -> {
                StringBuilder body = new StringBuilder();
                String[] sizes = {"0px 600px", "600px 0px", "0% 300%", "300% 0%", "600px 600px"};
                for (int i = 0; i < sizes.length; i++) {
                    String id = i == 4 ? "visible" : "zero-" + i;
                    body.append("<div id=\"").append(id).append("\" class=\"zero-background\" data-paste-progressiveresolution")
                        .append(" data-image-sources=\"#sources-").append(id).append("\" style=\"background-size:")
                        .append(sizes[i]).append("\"></div><script type=\"application/json\" id=\"sources-").append(id).append("\">")
                        .append("{\"src\":\"/checks/zero-base-100x100.png\",\"width\":100,\"height\":100,\"upgrades\":[")
                        .append("{\"src\":\"/checks/").append(id).append("-sharp-600x600.png\",\"width\":600,\"height\":600}]}</script>");
                }
                routeCheckPage(context, "zero-background.html", checkPage(
                    ".zero-background{display:inline-block;width:200px;height:200px;background-repeat:no-repeat;" +
                    "background-image:url('/checks/zero-base-100x100.png')}",
                    body.toString(), RESOLUTION_SCRIPTS, null), zeroBackgroundRequests);
            },
            (page, evidence) -> {
                openCheckPage(page, "zero-background.html");
                awaitActive(page, "getComputedStyle(document.getElementById('visible')).backgroundImage.includes('visible-sharp-600x600.png')");
                page.waitForTimeout(250);
                List<String> unnecessary = zeroBackgroundRequests.stream()
                    .filter(request -> request.matches(".*zero-[0-3]-sharp-600x600\\.png$")).toList();
                evidence.put("unnecessaryUpgradeRequests", unnecessary);
                evidence.put("backgroundSizes", page.evaluate("() => Array.from(document.querySelectorAll('.zero-background'), element => getComputedStyle(element).backgroundSize)"));
                require(unnecessary.isEmpty(), "unpainted backgrounds requested sharper images: " + unnecessary);
            });

        // On touch, a height-only viewport change is the browser toolbar:
        // the full-height image keeps its height, so nothing below the
        // hero shifts. A width change still re-applies it.
        scenario(browser, engine, "heroscroll keeps the full-height image on a touch height-only resize",
            Map.of("hasTouch", true, "viewport", new int[]{390, 664}),
            context -> routeCheckPage(context, "hero-touch.html", checkPage(
                ".paste-ui-hero{position:relative}.paste-ui-hero-image{background:#99c}.hs-after{height:3000px}",
                "<section class=\"paste-ui-hero\"><div class=\"paste-ui-hero-image\" force-full-height></div>" +
                "<div class=\"paste-ui-hero-content\">hello</div></section><div class=\"hs-after\" id=\"hs-after\">text</div>",
                HEROSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "hero-touch.html");
                require((Boolean) page.evaluate("() => 'ontouchstart' in window"), "the context does not present a touch device");
                awaitActive(page, "() => document.querySelector('.paste-ui-hero-image').style.height === '664px'");
                page.evaluate("() => window.scrollTo(0, 300)");
                frames(page);
                String read = "() => ({height: document.querySelector('.paste-ui-hero-image').style.height," +
                    " afterTop: Math.round(document.getElementById('hs-after').getBoundingClientRect().top + scrollY)})";
                Map<?, ?> before = (Map<?, ?>) page.evaluate(read);
                page.setViewportSize(390, 745);
                page.waitForTimeout(150);
                frames(page);
                Map<?, ?> after = (Map<?, ?>) page.evaluate(read);
                evidence.put("before", before);
                evidence.put("afterHeightOnly", after);
                require(before.equals(after), "a height-only touch resize moved the hero geometry: " + before + " -> " + after);
                page.setViewportSize(420, 745);
                awaitActive(page, "() => document.querySelector('.paste-ui-hero-image').style.height === '745px'");
                evidence.put("afterWidthChange", page.evaluate(read));
            });

        // The module owns what it wrote, not the reflected img.src: a
        // same-document URL change that moves the base directory changes
        // the reflected value, never the ownership.
        scenario(browser, engine, "progressiveresolution keeps its srcset when the base directory moves",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "products/widget", checkPage(
                "#bm-host{display:block;width:600px;height:600px}",
                "<img id=\"bm-host\" src=\"images/bm-640x640.png\" width=\"600\" height=\"600\" alt=\"product\"" +
                " data-paste-progressiveresolution data-image-sources=\"#bm-sources\">" +
                "<script type=\"application/json\" id=\"bm-sources\">{\"src\":\"images/bm-640x640.png\"," +
                "\"width\":640,\"height\":640,\"upgrades\":[{\"src\":\"images/bm-1280x1280.png\",\"width\":1280,\"height\":1280}]}</script>",
                RESOLUTION_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "products/widget");
                awaitActive(page, "() => /\\/checks\\/products\\/images\\/bm-1280x1280\\.png$/.test(document.getElementById('bm-host').currentSrc)");
                page.evaluate("() => history.replaceState(null, '', location.pathname + '/')");
                // A paint-size change is a policy input: the pass that
                // follows judges ownership again.
                page.evaluate("() => { document.getElementById('bm-host').style.width = '590px'; }");
                frames(page);
                page.waitForTimeout(400);
                Map<?, ?> state = (Map<?, ?>) page.evaluate("() => { const i = document.getElementById('bm-host');" +
                    " return {srcset: i.getAttribute('srcset') || '', currentSrc: i.currentSrc, src: i.src}; }");
                evidence.put("state", state);
                require(String.valueOf(state.get("srcset")).contains("bm-1280x1280.png"),
                    "the module withdrew its own srcset after a base move: " + state);
                require(String.valueOf(state.get("currentSrc")).endsWith("/checks/products/images/bm-1280x1280.png"),
                    "the displayed source changed after a base move: " + state);
            });

        // A nested scroller far below the fold is not near the page
        // viewport: nothing is prepared until the page brings it close.
        List<String> nestedRequests = new ArrayList<>();
        scenario(browser, engine, "a nested scroller far below the fold requests no frames until the page scrolls to it", null,
            context -> routeCheckPage(context, "nested-far.html", checkPage(
                "#nf-scroller{height:400px;overflow:auto}" +
                "#nf-host{display:block;height:300px;background-size:cover;background-image:url('/checks/nf-poster-320x180.png')}",
                "<div style=\"height:3000px\"></div><div id=\"nf-scroller\"><div style=\"height:500px\"></div>" +
                "<section id=\"nf-scope\" style=\"height:1000px\" data-paste-scrollscrub data-scrub-root=\"#nf-scroller\">" +
                "<i id=\"nf-host\" data-paste-imagesequence=\"#nf-frames\"></i>" +
                "<script type=\"application/json\" id=\"nf-frames\">" + catalogJson("nf", 12, 320, 180, 0, 0) + "</script>" +
                "</section><div style=\"height:1000px\"></div></div><div style=\"height:2000px\"></div>",
                SEQUENCE_SCRIPTS, null), nestedRequests),
            (page, evidence) -> {
                openCheckPage(page, "nested-far.html");
                page.waitForTimeout(800);
                frames(page);
                List<String> early = new ArrayList<>();
                for (String request : nestedRequests) if (request.contains("nf-frame-")) early.add(request);
                evidence.put("framesBeforeScroll", early);
                require(early.isEmpty(), "frames were requested for a scroller 3000px below the fold: " + early);
                page.evaluate("() => { const s = document.getElementById('nf-scroller');" +
                    " window.scrollTo(0, s.getBoundingClientRect().top + scrollY - 200); }");
                awaitActive(page, "() => /nf-frame-\\d+-/.test(getComputedStyle(document.getElementById('nf-host')).backgroundImage)");
                evidence.put("framesAfterScroll", nestedRequests.stream().filter(r -> r.contains("nf-frame-")).count());
            });

        // A foreign src write after the module committed its upgrade is
        // noticed on its own, with no other input: the module stands down
        // and the new picture shows.
        scenario(browser, engine, "progressiveresolution stands down promptly on a foreign src write",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "foreign-src.html", checkPage(
                "#fw-host{display:block;width:600px;height:600px}",
                "<img id=\"fw-host\" src=\"/checks/fw-640x640.png\" width=\"600\" height=\"600\" alt=\"carousel slide\"" +
                " data-paste-progressiveresolution data-image-sources=\"#fw-sources\">" +
                "<script type=\"application/json\" id=\"fw-sources\">{\"src\":\"/checks/fw-640x640.png\"," +
                "\"width\":640,\"height\":640,\"upgrades\":[{\"src\":\"/checks/fw-1280x1280.png\",\"width\":1280,\"height\":1280}]}</script>",
                RESOLUTION_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "foreign-src.html");
                awaitActive(page, "() => document.getElementById('fw-host').currentSrc.endsWith('/checks/fw-1280x1280.png')");
                page.evaluate("() => { document.getElementById('fw-host').src = '/checks/next-slide-600x600.png'; }");
                awaitActive(page, "() => { const i = document.getElementById('fw-host');" +
                    " return !i.hasAttribute('srcset') && i.currentSrc.endsWith('/checks/next-slide-600x600.png'); }",
                    null, new Page.WaitForFunctionOptions().setTimeout(1500));
                evidence.put("currentSrc", page.evaluate("() => document.getElementById('fw-host').currentSrc"));
            });

        scenario(browser, engine, "scrollscrub refreshes appended content without a window resize", null,
            context -> routeCheckPage(context, "scrub-append.html", checkPage(
                "#append-root{height:400px;overflow:auto}#original{height:1600px}",
                """
                <div id="append-root"><div id="append-scope" data-paste-scrollscrub
                  data-scrub-mode="container" data-scrub-root="#append-root"></div>
                  <div id="original"></div></div>
                """, SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-append.html");
                awaitActive(page, "document.getElementById('append-scope').style.getPropertyValue('--paste-scrub-progress') === '0'");
                page.evaluate("() => { const root = document.getElementById('append-root');" +
                    " const added = document.createElement('div'); added.id = 'appended'; added.style.height = '1200px';" +
                    " root.appendChild(added); root.scrollTop = 600; }");
                awaitActive(page, "document.getElementById('append-scope').style.getPropertyValue('--paste-scrub-progress') === '0.25'");
                evidence.put("afterAppend", property(page, "#append-scope"));
                // The new child's later growth also needs resize coverage.
                page.evaluate("document.getElementById('appended').style.height = '1800px'");
                awaitActive(page, "document.getElementById('append-scope').style.getPropertyValue('--paste-scrub-progress') === '0.2'");
                evidence.put("afterGrowth", property(page, "#append-scope"));
                page.evaluate("document.getElementById('appended').remove()");
                awaitActive(page, "document.getElementById('append-scope').style.getPropertyValue('--paste-scrub-progress') === '0.5'");
                evidence.put("afterRemoval", property(page, "#append-scope"));
            });

        List<String> nestedLazyRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sharpens a lazy image revealed by a nested scroller", null,
            context -> routeCheckPage(context, "nested-lazy.html", checkPage(
                "#lazy-root{height:300px;overflow:auto}#lazy-spacer{height:2500px}",
                """
                <div id="lazy-root"><div id="lazy-spacer"></div>
                  <img id="nested-lazy" loading="lazy" src="/checks/nested-base-100x100.png"
                    width="200" height="200" data-paste-progressiveresolution data-image-sources="#nested-sources"></div>
                <script type="application/json" id="nested-sources">
                {"src":"/checks/nested-base-100x100.png","width":100,"height":100,
                 "upgrades":[{"src":"/checks/nested-sharp-200x200.png","width":200,"height":200}]}</script>
                """, RESOLUTION_SCRIPTS, null), nestedLazyRequests),
            (page, evidence) -> {
                openCheckPage(page, "nested-lazy.html");
                frames(page);
                require(nestedLazyRequests.stream().noneMatch(path -> path.contains("nested-sharp")),
                    "the offscreen lazy image sharpened before scrolling");
                page.evaluate("document.getElementById('lazy-root').scrollTop = 2500");
                awaitActive(page, "document.getElementById('nested-lazy').currentSrc.endsWith('/checks/nested-sharp-200x200.png')");
                require(((Number) page.evaluate("window.scrollY")).intValue() == 0, "the window scrolled");
                evidence.put("requests", nestedLazyRequests);
            });

        // Layout alone can carry a lazy image near: content above it
        // collapses while the page stays at the top, so nothing scrolls,
        // the window keeps its size and the image keeps its box.
        List<String> collapseLazyRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sharpens a lazy image that collapsing content brings near", null,
            context -> routeCheckPage(context, "collapse-lazy.html", checkPage(
                "#collapse-spacer{height:6000px}",
                """
                <div id="collapse-spacer"></div>
                <img id="collapse-lazy" loading="lazy" src="/checks/collapse-base-100x100.png"
                  width="200" height="200" data-paste-progressiveresolution data-image-sources="#collapse-sources">
                <script type="application/json" id="collapse-sources">
                {"src":"/checks/collapse-base-100x100.png","width":100,"height":100,
                 "upgrades":[{"src":"/checks/collapse-sharp-200x200.png","width":200,"height":200}]}</script>
                """, RESOLUTION_SCRIPTS, null), collapseLazyRequests),
            (page, evidence) -> {
                openCheckPage(page, "collapse-lazy.html");
                frames(page);
                require(collapseLazyRequests.stream().noneMatch(path -> path.contains("collapse-sharp")),
                    "the far lazy image sharpened before the content above it collapsed");
                page.evaluate("document.getElementById('collapse-spacer').style.height = '100px'");
                awaitActive(page, "document.getElementById('collapse-lazy').currentSrc.endsWith('/checks/collapse-sharp-200x200.png')",
                    null, new Page.WaitForFunctionOptions().setTimeout(3000));
                require(((Number) page.evaluate("window.scrollY")).intValue() == 0, "the window scrolled");
                evidence.put("requests", collapseLazyRequests);
            });

        // loading="lazy" is the author's deferral: no upgrade downloads
        // while the image is far from the viewport, and it still upgrades
        // once the image comes near.
        List<String> lazyRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution leaves a far loading=lazy image alone until it nears",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "lazy.html", checkPage(
                ".lz-spacer{height:6000px}",
                "<div class=\"lz-spacer\"></div><img id=\"lz-host\" loading=\"lazy\" src=\"/checks/lz-base-640x640.png\"" +
                " width=\"640\" height=\"640\" alt=\"far image\" data-paste-progressiveresolution data-image-sources=\"#lz-sources\">" +
                "<script type=\"application/json\" id=\"lz-sources\">{\"src\":\"/checks/lz-base-640x640.png\"," +
                "\"width\":640,\"height\":640,\"upgrades\":[{\"src\":\"/checks/lz-up-1280x1280.png\",\"width\":1280,\"height\":1280}]}</script>",
                RESOLUTION_SCRIPTS, null), lazyRequests),
            (page, evidence) -> {
                openCheckPage(page, "lazy.html");
                page.waitForTimeout(1200);
                List<String> early = new ArrayList<>();
                for (String request : lazyRequests) if (request.contains("lz-up-")) early.add(request);
                evidence.put("upgradesBeforeScroll", early);
                require(early.isEmpty(), "a far lazy image downloaded its upgrade at load: " + early);
                page.evaluate("() => document.getElementById('lz-host').scrollIntoView()");
                awaitActive(page, "() => document.getElementById('lz-host').currentSrc.endsWith('/checks/lz-up-1280x1280.png')");
                evidence.put("requests", lazyRequests);
            });

        // A multistatepop listener that changes the selection while it is
        // announced: the top history entry describes the final selection.
        scenario(browser, engine, "multistate history matches the final selection after a nested listener change", null,
            context -> routeCheckPage(context, "multistate-nested.html", multistatePage("",
                "paste.require(['paste.ui.multistate'], function (module, multistate) {" +
                " multistate.events.multistatepop.subscribe(function () {" +
                "  var state = multistate.getCurrentState();" +
                "  if (state.area1 === 'b' && state.area2 === 'b') { document.getElementById('ms-a2a').click(); }" +
                " });" +
                " window.multistateListening = true; });"), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-nested.html");
                page.waitForFunction("() => window.multistateListening === true");
                page.click("#ms-a1b");
                page.waitForTimeout(200);
                Map<?, ?> selection = multistateSelection(page);
                evidence.put("selection", selection);
                active("b".equals(selection.get("area1")) && "a".equals(selection.get("area2")),
                    "the nested change did not apply: " + selection);
                String hash = String.valueOf(selection.get("hash"));
                require(hash.contains("area1:b") && hash.contains("area2:a") && !hash.contains("area2:b"),
                    "the top history entry describes a superseded selection: " + hash);
            });

        // <a href="#"> is an in-page link, not Back to the first entry:
        // the chosen tab stays chosen.
        scenario(browser, engine, "multistate keeps the selected tab across an href=\"#\" link", null,
            context -> routeCheckPage(context, "multistate-top.html",
                multistatePage("<p style=\"height:2000px\"><a id=\"ms-top\" href=\"#\">Back to top</a></p>", null), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-top.html");
                page.click("#ms-a1b");
                page.waitForTimeout(100);
                active("b".equals(multistateSelection(page).get("area1")), "the tab change did not apply");
                page.click("#ms-top");
                page.waitForTimeout(300);
                Map<?, ?> selection = multistateSelection(page);
                evidence.put("selection", selection);
                require(String.valueOf(selection.get("href")).endsWith("#"), "the link did not navigate to '#': " + selection);
                require("b".equals(selection.get("area1")), "an href=\"#\" link reset the chosen tab: " + selection);
                require((Boolean) page.evaluate("() => document.querySelector('[data-multistate-key=area1][data-multistate-value=b]')" +
                    ".hasAttribute('data-multistate-state')"), "the chosen panel lost its reflected state");
            });

        // Unnamed radios of one key are grouped into strips by their
        // markup: a stray radio, strips that differ in values, a flat
        // pair of strips and a key whose text ends like a strip number
        // each keep a native group of their own, while authored names
        // and form submission stay as authored.
        java.util.function.Function<String[], String> msStripRadio = spec ->
            "<input id=\"" + spec[0] + "\" type=\"radio\" data-multistate-key=\"" + spec[1] + "\" value=\"" + spec[2] + "\"" +
            (spec.length > 3 ? " " + spec[3] : "") + "><label for=\"" + spec[0] + "\">" + spec[2] + "</label>";
        String msStripPanels = "<div data-multistate-key=\"tab\" data-multistate-value=\"overview\">overview panel</div>" +
            "<div data-multistate-key=\"tab\" data-multistate-value=\"specs\">specs panel</div>" +
            "<div data-multistate-key=\"tab\" data-multistate-value=\"gallery\">gallery panel</div>" +
            "<div data-multistate-key=\"a\" data-multistate-value=\"x\">a x</div>" +
            "<div data-multistate-key=\"a\" data-multistate-value=\"y\">a y</div>" +
            "<div data-multistate-key=\"a:1\" data-multistate-value=\"p\">a:1 p</div>" +
            "<div data-multistate-key=\"a:1\" data-multistate-value=\"q\">a:1 q</div>" +
            "<div data-multistate-key=\"size\" data-multistate-value=\"s\">size s</div>" +
            "<div data-multistate-key=\"size\" data-multistate-value=\"m\">size m</div>";
        String msStripBody = "<button id=\"ms-before\">before</button>" +
            msStripRadio.apply(new String[] {"ms-stray", "tab", "overview"}) +
            "<div id=\"ms-strip-a\">" + msStripRadio.apply(new String[] {"ms-a1", "tab", "overview", "checked"}) +
            msStripRadio.apply(new String[] {"ms-a2", "tab", "specs"}) + "</div>" +
            "<div id=\"ms-strip-b\">" + msStripRadio.apply(new String[] {"ms-b1", "tab", "overview"}) +
            msStripRadio.apply(new String[] {"ms-b2", "tab", "specs"}) +
            msStripRadio.apply(new String[] {"ms-b3", "tab", "gallery"}) + "</div>" +
            "<div id=\"ms-strip-c\" role=\"tablist\">" + msStripRadio.apply(new String[] {"ms-c1", "tab", "overview"}) +
            msStripRadio.apply(new String[] {"ms-c2", "tab", "specs"}) + "</div>" +
            "<div id=\"ms-flat\">" + msStripRadio.apply(new String[] {"ms-s1x", "a", "x", "checked"}) +
            msStripRadio.apply(new String[] {"ms-s1y", "a", "y"}) +
            msStripRadio.apply(new String[] {"ms-s2x", "a", "x"}) +
            msStripRadio.apply(new String[] {"ms-s2y", "a", "y"}) +
            msStripRadio.apply(new String[] {"ms-kp", "a:1", "p", "checked"}) +
            msStripRadio.apply(new String[] {"ms-kq", "a:1", "q"}) + "</div>" +
            "<form id=\"ms-form\" action=\"#\"><fieldset>" +
            msStripRadio.apply(new String[] {"ms-size-s", "size", "s", "name=\"size\" checked"}) +
            msStripRadio.apply(new String[] {"ms-size-m", "size", "m", "name=\"size\""}) + "</fieldset></form>" +
            msStripPanels + "<button id=\"ms-after\">after</button>";
        String msStripChecked = "() => Array.from(document.querySelectorAll('input[type=radio]:checked'), r => r.id).sort().join(' ')";
        scenario(browser, engine, "multistate groups unnamed radios into strips by markup", null,
            context -> routeCheckPage(context, "multistate-strips.html",
                checkPage("[data-multistate-value]{display:none}[data-multistate-state]{display:block}",
                    msStripBody, MULTISTATE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-strips.html");
                active((Boolean) page.evaluate("() => document.querySelector('[data-multistate-key=tab]" +
                    "[data-multistate-value=overview]').hasAttribute('data-multistate-state')"),
                    "the module did not reflect the authored default");
                @SuppressWarnings("unchecked")
                List<String> groups = (List<String>) page.evaluate("() => { const by = {};" +
                    " document.querySelectorAll('input[type=radio]').forEach(r => (by[r.name] = by[r.name] || []).push(r.id));" +
                    " return Object.values(by).map(g => g.join(' ')).sort(); }");
                @SuppressWarnings("unchecked")
                List<String> names = (List<String>) page.evaluate(
                    "() => Array.from(document.querySelectorAll('input[type=radio]'), r => r.id + '=' + r.name)");
                evidence.put("groups", groups);
                evidence.put("names", names);
                require(groups.equals(List.of("ms-a1 ms-a2", "ms-b1 ms-b2 ms-b3", "ms-c1 ms-c2", "ms-kp ms-kq",
                        "ms-s1x ms-s1y", "ms-s2x ms-s2y", "ms-size-s ms-size-m", "ms-stray")),
                    "the native radio groups do not follow the strips: " + names);
                require(names.contains("ms-size-s=size") && names.contains("ms-size-m=size"),
                    "an authored name was rewritten: " + names);

                // ArrowRight inside the strip that has the extra value
                // reaches it, and wraps within that strip.
                page.click("#ms-b2");
                page.focus("#ms-b2");
                page.keyboard().press("ArrowRight");
                page.waitForTimeout(100);
                String afterGallery = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("arrowToGallery", afterGallery + " " + page.evaluate("() => location.hash"));
                require("ms-b3".equals(page.evaluate("() => document.activeElement.id")) &&
                        String.valueOf(page.evaluate("() => location.hash")).contains("tab:gallery"),
                    "ArrowRight in the longer strip did not reach its extra value: " + afterGallery);
                require(!afterGallery.contains("ms-a") && !afterGallery.contains("ms-c") && !afterGallery.contains("ms-stray"),
                    "a strip without the value kept a radio checked: " + afterGallery);

                // Tab with a value only one strip offers still stops in
                // every strip: on the checked radio where a strip has
                // one, and on the strip's radios where it has none (one
                // or each, as the engine treats an unchecked group).
                // WebKit's default Tab skips buttons and radios; Option+Tab
                // walks every control, as full keyboard access does.
                String msStripTab = "webkit".equals(engine) ? "Alt+Tab" : "Tab";
                page.focus("#ms-before");
                List<String> stops = new ArrayList<>();
                for (int press = 0; press < 12; press += 1) {
                    page.keyboard().press(msStripTab);
                    String focused = String.valueOf(page.evaluate("() => document.activeElement.id"));
                    if ("ms-after".equals(focused)) break;
                    stops.add(focused);
                }
                evidence.put("tabStops", stops);
                List<String> strippedStops = new ArrayList<>(stops);
                strippedStops.removeAll(List.of("ms-a2", "ms-c2"));
                require(strippedStops.equals(List.of("ms-stray", "ms-a1", "ms-b3", "ms-c1", "ms-s1x", "ms-s2x", "ms-kp", "ms-size-s")),
                    "Tab did not stop in every strip, or left a checked radio for another: " + stops);

                // Back from the extra value along its own strip (WebKit
                // does not wrap a radio group, so the walk goes left).
                page.focus("#ms-b3");
                page.keyboard().press("ArrowLeft");
                page.keyboard().press("ArrowLeft");
                page.waitForTimeout(100);
                String overview = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("arrowBackToOverview", overview);
                require("ms-b1".equals(page.evaluate("() => document.activeElement.id")) &&
                        overview.contains("ms-a1") && overview.contains("ms-c1") && overview.contains("ms-stray"),
                    "ArrowLeft from the extra value left its strip or did not select overview everywhere: " + overview);

                // The shorter strip's arrows stay inside it.
                page.focus("#ms-a1");
                page.keyboard().press("ArrowRight");
                page.waitForTimeout(100);
                String specs = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("arrowInShortStrip", specs);
                require("ms-a2".equals(page.evaluate("() => document.activeElement.id")) &&
                        specs.contains("ms-b2") && specs.contains("ms-c2"),
                    "ArrowRight in the shorter strip left it or did not select specs everywhere: " + specs);

                // Key 'a' strip 1 and key 'a:1' are separate groups.
                page.click("#ms-s2y");
                page.waitForTimeout(100);
                String colon = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("colonKeys", colon);
                require(colon.contains("ms-kp") && colon.contains("ms-s1y") && colon.contains("ms-s2y"),
                    "choosing key a unchecked key a:1 or a mirrored strip: " + colon);
                require(String.valueOf(page.evaluate("() => location.hash")).contains("a%3A1:p"),
                    "key a:1 left the fragment: " + page.evaluate("() => location.hash"));

                // Hash round-trip.
                String beforeHash = String.valueOf(page.evaluate(msStripChecked));
                page.evaluate("() => { location.hash = '#tab:gallery,a:x,a%3A1:q,size:m'; }");
                page.waitForTimeout(200);
                String hashed = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("hashApplied", hashed);
                require(hashed.equals("ms-b3 ms-kq ms-s1x ms-s2x ms-size-m"),
                    "the fragment did not check exactly its triggers: " + hashed);
                page.evaluate("() => history.back()");
                page.waitForTimeout(300);
                String back = String.valueOf(page.evaluate(msStripChecked));
                evidence.put("hashBack", back);
                require(back.equals(beforeHash), "Back did not restore the selection: " + beforeHash + " -> " + back);

                // Form submission keeps the authored name.
                page.click("#ms-size-m");
                page.waitForTimeout(100);
                Object submitted = page.evaluate("() => Array.from(new FormData(document.getElementById('ms-form'))," +
                    " e => e[0] + '=' + e[1]).join('&')");
                evidence.put("formData", submitted);
                require("size=m".equals(submitted), "the form submits other than its authored name: " + submitted);
            });

        // Interleaved strips: a table with a strip per column, list items
        // holding one radio of each strip, a grid filled row by row. Each
        // column keeps one native group, next to strips that differ in
        // values row by row, and a key with a space keeps its own text in
        // the generated name.
        java.util.function.Function<String[], String> msWeaveRadio = spec ->
            "<input id=\"" + spec[0] + "\" type=\"radio\" data-multistate-key=\"" + spec[1] + "\" value=\"" + spec[2] + "\"" +
            (spec.length > 3 ? " " + spec[3] : "") + "><label for=\"" + spec[0] + "\">" + spec[0] + "</label>";
        StringBuilder msWeaveBody = new StringBuilder("<button id=\"msw-before\">before</button><table><tbody>");
        String[] msWeaveValues = {"o", "s", "g"};
        for (int row = 0; row < 3; row += 1) {
            String v = msWeaveValues[row];
            msWeaveBody.append("<tr><td>").append(msWeaveRadio.apply(new String[] {"msw-ca" + row, "cols", v, row == 0 ? "checked" : ""}))
                .append("</td><td>").append(msWeaveRadio.apply(new String[] {"msw-cb" + row, "cols", v})).append("</td></tr>");
        }
        msWeaveBody.append("</tbody></table><div>");
        for (int row = 0; row < 3; row += 1) {
            String v = msWeaveValues[row];
            msWeaveBody.append("<div>").append(msWeaveRadio.apply(new String[] {"msw-ia" + row, "items", v, row == 0 ? "checked" : ""}))
                .append(msWeaveRadio.apply(new String[] {"msw-ib" + row, "items", v})).append("</div>");
        }
        msWeaveBody.append("</div><div style=\"display:grid;grid-template-columns:1fr 1fr\">");
        for (int row = 0; row < 3; row += 1) {
            String v = msWeaveValues[row];
            msWeaveBody.append("<div>").append(msWeaveRadio.apply(new String[] {"msw-ga" + row, "grid", v, row == 0 ? "checked" : ""}))
                .append("</div><div>").append(msWeaveRadio.apply(new String[] {"msw-gb" + row, "grid", v})).append("</div>");
        }
        msWeaveBody.append("</div><table><tbody><tr>")
            .append("<td>").append(msWeaveRadio.apply(new String[] {"msw-ra0", "rows", "o", "checked"})).append("</td>")
            .append("<td>").append(msWeaveRadio.apply(new String[] {"msw-ra1", "rows", "s"})).append("</td></tr><tr>")
            .append("<td>").append(msWeaveRadio.apply(new String[] {"msw-rb0", "rows", "o"})).append("</td>")
            .append("<td>").append(msWeaveRadio.apply(new String[] {"msw-rb1", "rows", "s"})).append("</td>")
            .append("<td>").append(msWeaveRadio.apply(new String[] {"msw-rb2", "rows", "g"})).append("</td></tr></tbody></table>")
            .append("<div>").append(msWeaveRadio.apply(new String[] {"msw-na0", "north america", "o", "checked"}))
            .append(msWeaveRadio.apply(new String[] {"msw-na1", "north america", "s"})).append("</div>");
        for (String key : new String[] {"cols", "items", "grid", "rows", "north america"}) {
            for (String v : msWeaveValues) {
                msWeaveBody.append("<div data-multistate-key=\"").append(key).append("\" data-multistate-value=\"").append(v)
                    .append("\">").append(key).append(' ').append(v).append("</div>");
            }
        }
        msWeaveBody.append("<button id=\"msw-after\">after</button>");
        scenario(browser, engine, "multistate keeps interleaved strips in one group per column", null,
            context -> routeCheckPage(context, "multistate-interleaved.html",
                checkPage("[data-multistate-value]{display:none}[data-multistate-state]{display:block}",
                    msWeaveBody.toString(), MULTISTATE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-interleaved.html");
                active((Boolean) page.evaluate("() => document.querySelector('[data-multistate-key=cols]" +
                    "[data-multistate-value=o]').hasAttribute('data-multistate-state')"),
                    "the module did not reflect the authored default");
                @SuppressWarnings("unchecked")
                List<String> groups = (List<String>) page.evaluate("() => { const by = {};" +
                    " document.querySelectorAll('input[type=radio]').forEach(r => (by[r.name] = by[r.name] || []).push(r.id));" +
                    " return Object.values(by).map(g => g.join(' ')).sort(); }");
                @SuppressWarnings("unchecked")
                List<String> names = (List<String>) page.evaluate(
                    "() => Array.from(document.querySelectorAll('input[type=radio]'), r => r.id + '=' + r.name)");
                evidence.put("groups", groups);
                evidence.put("names", names);
                require(groups.equals(List.of("msw-ca0 msw-ca1 msw-ca2", "msw-cb0 msw-cb1 msw-cb2",
                        "msw-ga0 msw-ga1 msw-ga2", "msw-gb0 msw-gb1 msw-gb2", "msw-ia0 msw-ia1 msw-ia2",
                        "msw-ib0 msw-ib1 msw-ib2", "msw-na0 msw-na1",
                        "msw-ra0 msw-ra1", "msw-rb0 msw-rb1 msw-rb2")),
                    "the native radio groups do not follow the strips: " + names);
                require(names.contains("msw-na0=paste-ui-multistate:north america"),
                    "a key with a space lost its own text in the generated name: " + names);

                // ArrowDown in a column walks the column and every
                // mirrored strip follows.
                String msWeaveChecked = "() => Array.from(document.querySelectorAll('input[data-multistate-key=cols]:checked')," +
                    " r => r.id).sort().join(' ')";
                page.focus("#msw-ca0");
                page.keyboard().press("ArrowDown");
                page.waitForTimeout(100);
                Object focused = page.evaluate("() => document.activeElement.id");
                Object columns = page.evaluate(msWeaveChecked);
                evidence.put("arrowInColumn", focused + " " + columns);
                require("msw-ca1".equals(focused) && "msw-ca1 msw-cb1".equals(columns),
                    "ArrowDown in a column left it or did not select the next value everywhere: " + focused + " " + columns);
            });

        // A key holding a lone surrogate (which encodeURIComponent
        // refuses) binds and selects like any other, and the page's other
        // keys keep working. Page text cannot carry a lone surrogate; the
        // attribute is set before the module binds.
        scenario(browser, engine, "multistate binds a key holding a lone surrogate", null,
            context -> routeCheckPage(context, "multistate-lone-surrogate.html", multistatePage(
                "<input id=\"msl-a\" type=\"radio\" data-multistate-key=\"lone\" value=\"a\" checked><label for=\"msl-a\">a</label>" +
                "<input id=\"msl-b\" type=\"radio\" data-multistate-key=\"lone\" value=\"b\"><label for=\"msl-b\">b</label>" +
                "<div data-multistate-key=\"lone\" data-multistate-value=\"a\">lone a</div>" +
                "<div data-multistate-key=\"lone\" data-multistate-value=\"b\">lone b</div>" +
                "<script>document.querySelectorAll('[data-multistate-key=lone]').forEach(function (e) {" +
                " e.setAttribute('data-multistate-key', 'k:\\uD800'); });</script>", null), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-lone-surrogate.html");
                active((Boolean) page.evaluate("() => document.querySelector('[data-multistate-key=area1]" +
                    "[data-multistate-value=a]').hasAttribute('data-multistate-state')"),
                    "the module did not reflect the authored default of the page's other keys");
                page.click("#msl-b");
                page.waitForTimeout(100);
                Object lone = page.evaluate("() => Array.from(document.querySelectorAll('[data-multistate-state]')," +
                    " e => e.textContent).filter(t => t.startsWith('lone')).join(',')");
                evidence.put("loneSelection", lone);
                evidence.put("names", page.evaluate("() => document.getElementById('msl-a').name"));
                require("lone b".equals(lone), "the key holding a lone surrogate did not select: " + lone);
                page.click("#ms-a1b");
                page.waitForTimeout(100);
                // The fragment carries the escaped token, which does not
                // decode: read it raw.
                Object hash = page.evaluate("() => location.hash");
                Object area1 = page.evaluate("() => document.querySelector('[data-multistate-key=area1]" +
                    "[data-multistate-state]')?.textContent ?? null");
                evidence.put("hash", hash);
                evidence.put("area1", area1);
                require("area 1 panel b".equals(area1) && String.valueOf(hash).contains("area1:b"),
                    "another key stopped working beside the lone-surrogate key: " + area1 + " " + hash);
            });

        // Naming is linear in the radios: a thousand-radio strip re-scans
        // in a few milliseconds, not the seconds a pairwise comparison of
        // every radio with every other costs.
        scenario(browser, engine, "multistate names a thousand-radio strip without comparing every pair", null,
            context -> routeCheckPage(context, "multistate-long-strip.html",
                checkPage("", "<div id=\"msl\"></div><script>(function () { var h = '<section><ul>', v;" +
                    " for (v = 0; v < 1000; v += 1) { h += '<li><label><input type=radio data-multistate-key=k value=v' + v +" +
                    " (v ? '' : ' checked') + '>v' + v + '</label></li>'; }" +
                    " h += '</ul></section>'; for (v = 0; v < 1000; v += 1) {" +
                    " h += '<div data-multistate-key=k data-multistate-value=v' + v + '></div>'; }" +
                    " document.getElementById('msl').innerHTML = h; }());</script>", MULTISTATE_SCRIPTS,
                    "paste.require(['paste.ui.multistate'], function (module, multistate) {" +
                    " var start = performance.now(); multistate.initialize(true);" +
                    " window.multistateRescanMs = performance.now() - start; });"), null),
            (page, evidence) -> {
                openCheckPage(page, "multistate-long-strip.html");
                page.waitForFunction("() => typeof window.multistateRescanMs === 'number'");
                Object groups = page.evaluate("() => new Set(Array.from(document.querySelectorAll('input'), r => r.name)).size");
                active(Integer.valueOf(1).equals(groups) &&
                        (Boolean) page.evaluate("() => document.querySelector('input').name === 'paste-ui-multistate:k'"),
                    "the strip was not named as one group: " + groups);
                double rescan = ((Number) page.evaluate("() => window.multistateRescanMs")).doubleValue();
                evidence.put("rescanMs", rescan);
                require(rescan < 150, "re-scanning a thousand-radio strip took " + rescan + " ms");
            });

        // Measuring a collapsed field clamps its scroller for an instant;
        // under scroll-behavior: smooth the restore must still be a jump,
        // so no frame ever paints the clamped offset.
        scenario(browser, engine, "autogrow keeps a smooth scroller's offset with no glide", null,
            context -> routeCheckPage(context, "autogrow-smooth.html", checkPage(
                "#ag-box{height:300px;overflow:auto;scroll-behavior:smooth;border:1px solid #000}" +
                "#ag-spacer{height:1500px}" +
                "#ag-field{display:block;box-sizing:border-box;width:300px;min-height:80px;max-height:4000px;overflow-y:auto;font:16px/20px sans-serif}",
                "<div id=\"ag-box\"><div id=\"ag-spacer\"></div><textarea id=\"ag-field\" data-paste-autogrow rows=\"2\"></textarea></div>",
                AUTOGROW_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "autogrow-smooth.html");
                page.evaluate("() => { const f = document.getElementById('ag-field');" +
                    " f.value = Array.from({length: 30}, (v, i) => 'line ' + i).join('\\n');" +
                    " f.dispatchEvent(new Event('input', {bubbles: true})); }");
                page.waitForTimeout(400);
                double grown = ((Number) page.evaluate("() => document.getElementById('ag-field').getBoundingClientRect().height")).doubleValue();
                active(grown > 400, "the field did not grow with its content: " + grown);
                page.evaluate("() => { const b = document.getElementById('ag-box'); b.style.scrollBehavior = 'auto';" +
                    " b.scrollTop = b.scrollHeight; b.style.scrollBehavior = ''; }");
                page.waitForTimeout(300);
                double settled = ((Number) page.evaluate("() => document.getElementById('ag-box').scrollTop")).doubleValue();
                page.evaluate("() => { const f = document.getElementById('ag-field'); f.focus({preventScroll: true});" +
                    " f.setSelectionRange(f.value.length, f.value.length);" +
                    " window.agSamples = []; const t0 = performance.now(); const box = document.getElementById('ag-box');" +
                    " const sample = () => { window.agSamples.push(box.scrollTop); if (performance.now() - t0 < 900) requestAnimationFrame(sample); };" +
                    " requestAnimationFrame(sample); }");
                page.keyboard().type("x");
                page.waitForTimeout(1000);
                List<?> samples = (List<?>) page.evaluate("() => window.agSamples");
                double lowest = samples.stream().mapToDouble(v -> ((Number) v).doubleValue()).min().orElse(settled);
                evidence.put("settled", settled);
                evidence.put("lowestSample", lowest);
                evidence.put("samples", samples.size());
                require(settled > 0, "the scroller was not scrolled before typing");
                require(lowest >= settled - 1, "a frame painted the clamped offset " + lowest + " instead of " + settled);
            });

        // A height transition must not reach the measure: a collapse that
        // animates leaves scrollHeight at the old height and the field never
        // shrinks. The field styled shorter than its rows keeps its authored
        // floor, nothing the pass writes starts a height transition, and an
        // author's own inline transition comes back as written.
        scenario(browser, engine, "autogrow shrinks a field with a height transition and keeps a short rows floor", null,
            context -> routeCheckPage(context, "autogrow-transition.html", checkPage(
                ".tr{display:block;box-sizing:border-box;width:300px;padding:4px;margin:4px 0;min-height:80px;max-height:4000px;" +
                "overflow-y:auto;font:16px/20px sans-serif}" +
                "#tr-height{transition:height .2s}" +
                "#tr-all{transition:all .15s}" +
                // The mixin's own block with $transition passed.
                "[data-paste-autogrow].tr-mixin{min-height:80px;max-height:4000px;overflow-y:auto;transition:height .3s ease-out}" +
                "#tr-important{transition:height .25s !important}" +
                "#tr-delay{transition:height 0s .3s}" +
                "#tr-rows,#tr-rows-timed{height:100px}#tr-rows-timed{transition:height .2s}",
                "<textarea class=\"tr\" id=\"tr-height\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-all\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr tr-mixin\" id=\"tr-mixin\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-important\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-delay\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-inline\" data-paste-autogrow rows=\"2\" style=\"transition-duration:.2s;transition-property:height\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-none\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-rows\" data-paste-autogrow rows=\"12\"></textarea>" +
                "<textarea class=\"tr\" id=\"tr-rows-timed\" data-paste-autogrow rows=\"12\"></textarea>",
                AUTOGROW_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "autogrow-transition.html");
                @SuppressWarnings("unchecked")
                Map<String, Object> run = (Map<String, Object>) page.evaluate("async () => {" +
                    " const fields = Array.from(document.querySelectorAll('textarea.tr'));" +
                    " const frame = () => new Promise(r => requestAnimationFrame(r));" +
                    " const box = () => Object.fromEntries(fields.map(f => [f.id, Math.round(f.getBoundingClientRect().height)]));" +
                    " const typed = async value => { fields.forEach(f => { f.value = value; });" +
                    "  fields.forEach(f => f.dispatchEvent(new Event('input', {bubbles: true})));" +
                    "  const animated = []; let n = 12;" +
                    "  while (n--) { await frame(); fields.forEach(f => { if (animated.indexOf(f.id) < 0 &&" +
                    "   f.getAnimations().some(a => a.transitionProperty === 'height')) animated.push(f.id); }); }" +
                    "  await new Promise(r => setTimeout(r, 700)); return {box: box(), animated}; };" +
                    " await new Promise(r => setTimeout(r, 400));" +
                    " const authored = box();" +
                    " const grown = await typed(Array.from({length: 20}, (v, i) => 'line ' + i).join('\\n'));" +
                    " const shrunk = await typed('x');" +
                    " const inline = Object.fromEntries(fields.map(f => [f.id, [f.style.getPropertyValue('transition-duration')," +
                    "  f.style.getPropertyPriority('transition-duration'), f.style.getPropertyValue('transition-delay')]]));" +
                    " return {authored, grown, shrunk, inline}; }");
                evidence.putAll(run);
                Map<?, ?> authored = (Map<?, ?>) run.get("authored");
                Map<?, ?> grown = (Map<?, ?>) ((Map<?, ?>) run.get("grown")).get("box");
                Map<?, ?> shrunk = (Map<?, ?>) ((Map<?, ?>) run.get("shrunk")).get("box");
                Map<?, ?> inline = (Map<?, ?>) run.get("inline");
                for (Object id : authored.keySet()) {
                    int floor = ((Number) authored.get(id)).intValue();
                    int tall = ((Number) grown.get(id)).intValue();
                    int after = ((Number) shrunk.get(id)).intValue();
                    active(tall > 300, id + " did not grow with its content: " + floor + " -> " + tall);
                    require(after == floor, id + " did not shrink back to its authored " + floor + "px: " + tall + " -> " + after);
                }
                require(((Number) authored.get("tr-rows")).intValue() == 100,
                    "the rows field did not author at 100px: " + authored);
                require(((List<?>) ((Map<?, ?>) run.get("grown")).get("animated")).isEmpty() &&
                    ((List<?>) ((Map<?, ?>) run.get("shrunk")).get("animated")).isEmpty(),
                    "a sizing pass started a height transition: " + run);
                require(List.of("0.2s", "", "").equals(inline.get("tr-inline")),
                    "the author's inline transition was not put back as written: " + inline.get("tr-inline"));
                for (Object id : inline.keySet()) {
                    if (!"tr-inline".equals(id)) {
                        require(List.of("", "", "").equals(inline.get(id)), id + " kept an inline transition: " + inline.get(id));
                    }
                }
            });

        // An inline transition shorthand holding var() reads back nothing
        // through its longhands, so the hold must put the shorthand back
        // whole; and a class another module's write phase added earlier in
        // the same frame — on the field or on an ancestor — must transition
        // with the author's durations rather than land under the hold.
        scenario(browser, engine, "autogrow puts back an inline var() transition and lets a same-frame class change transition", null,
            context -> routeCheckPage(context, "autogrow-inline-transition.html", checkPage(
                ":root{--ag-t:height .3s, background-color 1s linear}" +
                ".ai{display:block;box-sizing:border-box;width:300px;padding:4px;margin:4px 0;min-height:80px;max-height:4000px;" +
                "overflow-y:auto;font:16px/20px sans-serif;background-color:rgb(255,255,255)}" +
                ".ai.dark,.ai-wrap.dark .ai{background-color:rgb(0,0,0)}" +
                "#ai-phased,#ai-ancestor{transition:background-color 2s linear,height .3s}",
                "<textarea class=\"ai\" id=\"ai-var\" data-paste-autogrow rows=\"2\" style=\"transition: var(--ag-t)\"></textarea>" +
                "<textarea class=\"ai\" id=\"ai-var-important\" data-paste-autogrow rows=\"2\" style=\"transition: var(--ag-t) !important\"></textarea>" +
                "<textarea class=\"ai\" id=\"ai-plain\" data-paste-autogrow rows=\"2\" style=\"transition: height .3s, background-color 1s linear\"></textarea>" +
                "<textarea class=\"ai\" id=\"ai-longhand\" data-paste-autogrow rows=\"2\"" +
                " style=\"transition-property: height, background-color; transition-duration: var(--ag-d, .3s)\"></textarea>" +
                "<textarea class=\"ai\" id=\"ai-phased\" data-paste-autogrow rows=\"2\"></textarea>" +
                "<div class=\"ai-wrap\" id=\"ai-wrap\"><textarea class=\"ai\" id=\"ai-ancestor\" data-paste-autogrow rows=\"2\"></textarea></div>" +
                // Registered before the module binds: this phased write runs
                // ahead of the module's own in the frame.
                "<script>['ai-phased', 'ai-ancestor'].forEach(id => document.getElementById(id).addEventListener('input', () =>" +
                " window.aiFrames.requestPhased(() => {}, () => document.getElementById(id === 'ai-phased' ? id : 'ai-wrap')" +
                ".classList.add('dark'))));</script>",
                AUTOGROW_SCRIPTS,
                "paste.define('check.autogrow-inline', ['paste.ui.utilities.animation-frame'], (m, frames) => { window.aiFrames = frames; return m; });"),
                null),
            (page, evidence) -> {
                openCheckPage(page, "autogrow-inline-transition.html");
                @SuppressWarnings("unchecked")
                Map<String, Map<String, Map<String, Object>>> run = (Map<String, Map<String, Map<String, Object>>>) page.evaluate("async () => {" +
                    " const frame = () => new Promise(r => requestAnimationFrame(r));" +
                    " const long = Array.from({length: 12}, (v, i) => 'line ' + i).join('\\n');" +
                    " const read = el => [el.style.getPropertyValue('transition'), el.style.getPropertyPriority('transition')," +
                    "  el.style.getPropertyValue('transition-duration'), getComputedStyle(el).transitionDuration].join('|');" +
                    " const anims = el => el.getAnimations().map(a => a.transitionProperty).sort().join(',');" +
                    " const grow = async el => { el.value = long; el.dispatchEvent(new Event('input', {bubbles: true}));" +
                    "  await frame(); await frame(); };" +
                    " await new Promise(r => setTimeout(r, 300));" +
                    " const out = {inline: {}, phased: {}};" +
                    " for (const id of ['ai-var', 'ai-var-important', 'ai-plain', 'ai-longhand']) {" +
                    "  const el = document.getElementById(id); const before = read(el); const floor = el.getBoundingClientRect().height;" +
                    "  await grow(el); const after = read(el); const grown = el.getBoundingClientRect().height;" +
                    // The author's transition still runs on a later change.
                    "  el.classList.add('dark'); getComputedStyle(el).backgroundColor; await frame();" +
                    "  out.inline[id] = {before, after, floor, grown, anims: anims(el)}; }" +
                    " for (const id of ['ai-phased', 'ai-ancestor']) {" +
                    "  const el = document.getElementById(id); const floor = el.getBoundingClientRect().height;" +
                    "  await grow(el);" +
                    "  out.phased[id] = {floor, grown: el.getBoundingClientRect().height, anims: anims(el)}; }" +
                    " return out; }");
                evidence.putAll(run);
                for (Map<String, Map<String, Object>> group : run.values()) {
                    for (Map.Entry<String, Map<String, Object>> field : group.entrySet()) {
                        Map<String, Object> state = field.getValue();
                        double floor = ((Number) state.get("floor")).doubleValue();
                        double grown = ((Number) state.get("grown")).doubleValue();
                        active(grown > floor + 100, field.getKey() + " did not grow with its content: " + floor + " -> " + grown);
                        List<String> running = List.of(String.valueOf(state.get("anims")).split(","));
                        require(running.contains("background-color"),
                            field.getKey() + " lost the author's background transition: running [" + state.get("anims") + "]");
                        require(!running.contains("height"), field.getKey() + " started a height transition: " + state.get("anims"));
                    }
                }
                for (Map.Entry<String, Map<String, Object>> field : run.get("inline").entrySet()) {
                    require(field.getValue().get("before").equals(field.getValue().get("after")),
                        field.getKey() + "'s inline transition was not put back as written: " + field.getValue().get("before") +
                        " -> " + field.getValue().get("after"));
                }
            });

        // A sharper rung on <img width height> sized by CSS auto: the
        // box keeps the base frame's size while the pixels sharpen.
        List<String> sharpenRequests = new ArrayList<>();
        scenario(browser, engine, "imagesequence sharpening never changes an auto-sized img box",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "sequence-sharpen.html", checkPage(
                "#sh-scope{min-height:120vh}.sh-after{height:200vh}#sh-host{width:auto;height:auto}",
                "<section id=\"sh-scope\" data-paste-scrollscrub data-scrub-start=\"top bottom\" data-scrub-end=\"bottom top\">" +
                "<img id=\"sh-host\" src=\"/checks/sh-frame-0-640x360.png\" width=\"640\" height=\"360\" alt=\"assembly\"" +
                " data-paste-imagesequence=\"#sh-frames\" data-paste-progressiveresolution>" +
                "<script type=\"application/json\" id=\"sh-frames\">" + catalogJson("sh", 4, 640, 360, 1280, 720) + "</script>" +
                "</section><div class=\"sh-after\"></div>",
                SEQUENCE_SCRIPTS, null), sharpenRequests),
            (page, evidence) -> {
                openCheckPage(page, "sequence-sharpen.html");
                page.evaluate("() => { window.shBoxes = []; const host = document.getElementById('sh-host'); const t0 = performance.now();" +
                    " const sample = () => { const r = host.getBoundingClientRect(); window.shBoxes.push([r.width, r.height]);" +
                    " if (performance.now() - t0 < 2500) requestAnimationFrame(sample); }; requestAnimationFrame(sample); }");
                awaitActive(page, "() => /-1280x720\\.png$/.test(document.getElementById('sh-host').currentSrc)");
                for (double fraction : new double[]{0.2, 0.4}) {
                    scrollTo(page, fraction);
                    page.waitForTimeout(400);
                }
                page.waitForTimeout(800);
                List<?> boxes = (List<?>) page.evaluate("() => window.shBoxes");
                List<Object> wrong = new ArrayList<>();
                for (Object box : boxes) {
                    List<?> size = (List<?>) box;
                    if (((Number) size.get(0)).doubleValue() != 640 || ((Number) size.get(1)).doubleValue() != 360) wrong.add(size);
                }
                evidence.put("samples", boxes.size());
                evidence.put("currentSrc", page.evaluate("() => document.getElementById('sh-host').currentSrc"));
                evidence.put("sharperRequests", sharpenRequests.stream().filter(r -> r.endsWith("-1280x720.png")).count());
                require(wrong.isEmpty(), "the img box left 640x360 while sharpening: " + wrong.subList(0, Math.min(5, wrong.size())));
            });

        // A delayed background-image transition lags the computed value
        // behind a chain of paints; a continuous scrub keeps every claim
        // (no inline write ever steps back) and rests on the range end.
        scenario(browser, engine, "imagesequence keeps a continuous scrub under a delayed background-image transition", null,
            context -> routeCheckPage(context, "sequence-delayed-transition.html", checkPage(
                ".dt-pad{height:100vh}#dt-band{height:600vh;position:relative}" +
                "#dt-scene{position:sticky;top:0;height:100vh}" +
                "#dt-host{display:block;width:640px;height:360px;background-size:cover;" +
                "background-image:url('/checks/dt-frame-0-160x90.png');transition:background-image .2s ease 40ms}",
                "<div class=\"dt-pad\"></div><section id=\"dt-band\"><div id=\"dt-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#dt-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"dt-host\" data-paste-imagesequence=\"#dt-frames\" data-sequence-from=\"0\" data-sequence-to=\"60\"></i>" +
                "<script type=\"application/json\" id=\"dt-frames\">" + catalogJson("dt", 61, 160, 90, 0, 0) + "</script>" +
                "</div></section><div class=\"dt-pad\"></div>",
                SEQUENCE_SCRIPTS,
                "window.dtWrites = []; (function () { const h = document.getElementById('dt-host');" +
                " new MutationObserver(function () { const m = /dt-frame-(\\d+)-/.exec(h.style.backgroundImage);" +
                " window.dtWrites.push(m ? Number(m[1]) : -1); }).observe(h, {attributes: true, attributeFilter: ['style']}); })();"),
                null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-delayed-transition.html");
                String sweep = "ms => new Promise(r => { const b = document.getElementById('dt-band').getBoundingClientRect();" +
                    " const s = b.top + scrollY, e = s + b.height - innerHeight; const t0 = performance.now();" +
                    " (function f() { const k = Math.min(1, (performance.now() - t0) / ms); window.scrollTo(0, s + (e - s) * k);" +
                    " if (k < 1) requestAnimationFrame(f); else r(); })(); })";
                // A slow first sweep lands every frame; the measured one
                // is fast enough to paint faster than the transition.
                page.evaluate(sweep, 4000);
                page.waitForTimeout(800);
                page.evaluate("() => window.scrollTo(0, 0)");
                page.waitForTimeout(600);
                page.evaluate("() => { window.dtWrites.length = 0; }");
                page.evaluate(sweep, 3000);
                page.waitForTimeout(1500);
                List<?> writes = (List<?>) page.evaluate("() => window.dtWrites");
                List<String> backward = new ArrayList<>();
                int previous = -1;
                for (Object write : writes) {
                    int index = ((Number) write).intValue();
                    if (previous >= 0 && index < previous && backward.size() < 8) backward.add(previous + "->" + index);
                    previous = index;
                }
                int painted = (Integer) page.evaluate("() => { const m = /dt-frame-(\\d+)-/.exec(" +
                    "getComputedStyle(document.getElementById('dt-host')).backgroundImage); return m ? Number(m[1]) : -1; }");
                evidence.put("writes", writes.size());
                evidence.put("backward", backward);
                evidence.put("painted", painted);
                active(writes.size() > 0, "the measured sweep painted nothing");
                require(backward.isEmpty(), "a claim was reverted mid-scrub: " + backward);
                require(painted == 60, "the scrub rested on frame " + painted + ", not the range end");
            });

        // An img writes a sharper rung as a srcset width descriptor sized
        // at the base's intrinsic width: under object-fit none at device
        // ratio 2 the same box gains density, so the rung is requested.
        scenario(browser, engine, "imagesequence sharpens an object-fit none img at device ratio 2",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "sequence-fit-none.html", checkPage(
                "#fn-scope{min-height:120vh}.fn-after{height:200vh}#fn-host{width:640px;height:360px;object-fit:none}",
                "<section id=\"fn-scope\" data-paste-scrollscrub data-scrub-start=\"top bottom\" data-scrub-end=\"bottom top\">" +
                "<img id=\"fn-host\" src=\"/checks/fn-frame-0-640x360.png\" width=\"640\" height=\"360\" alt=\"assembly\"" +
                " data-paste-imagesequence=\"#fn-frames\" data-paste-progressiveresolution>" +
                "<script type=\"application/json\" id=\"fn-frames\">" + catalogJson("fn", 4, 640, 360, 1280, 720) + "</script>" +
                "</section><div class=\"fn-after\"></div>",
                SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-fit-none.html");
                awaitActive(page, "() => /-1280x720\\.png$/.test(document.getElementById('fn-host').currentSrc)");
                evidence.put("currentSrc", page.evaluate("() => document.getElementById('fn-host').currentSrc"));
                evidence.put("box", page.evaluate("() => { const r = document.getElementById('fn-host').getBoundingClientRect();" +
                    " return [r.width, r.height]; }"));
            });

        // The optional host defaults, read from the mixin source itself,
        // never outrank the user agent's [hidden]: a hidden host stays
        // display none while a shown one still gets its block box.
        scenario(browser, engine, "stylesheet imagesequence host defaults leave a hidden host hidden", null,
            context -> {
                String rule;
                try {
                    Matcher block = Pattern.compile("(?m)^\\s*(:where\\(.*\\))\\s*\\{([^}]*)\\}")
                        .matcher(Files.readString(Path.of("modules/imagesequence/_mixin.scss")));
                    require(block.find(), "the mixin declares its host rule");
                    rule = block.group(1) + "{" + block.group(2) + "}";
                } catch (java.io.IOException error) {
                    throw new IllegalStateException(error);
                }
                routeCheckPage(context, "sequence-hidden.html", checkPage(rule,
                    "<i id=\"hd-hidden\" hidden data-paste-imagesequence=\"#hd-frames\"></i>" +
                    "<i id=\"hd-shown\" data-paste-imagesequence=\"#hd-frames\"></i>",
                    new String[0], null), null);
            },
            (page, evidence) -> {
                openCheckPage(page, "sequence-hidden.html");
                Object hidden = page.evaluate("() => getComputedStyle(document.getElementById('hd-hidden')).display");
                Object shown = page.evaluate("() => getComputedStyle(document.getElementById('hd-shown')).display");
                evidence.put("hidden", hidden);
                evidence.put("shown", shown);
                require("none".equals(hidden), "a hidden host computed display " + hidden);
                active("block".equals(shown), "a shown host computed display " + shown);
            });

        // Paints chained faster than a background-image transition: the
        // second paint lands inside the first one's delay, so the
        // computed value is still the authored base — neither the claim
        // nor the source it replaced. A delayed or running transition the
        // host lists keeps the claim, and once the transition reports the
        // change the host still upgrades. The undelayed transition is the
        // control; Firefox, which does not interpolate background-image,
        // computes each paint at once. A writer whose rule outranks the
        // inline layer still takes the display for good.
        for (String[] chain : new String[][]{
                {"delay", "3s", "upgrades"}, {"no delay", "0s", "upgrades"}, {"delay", "3s", "foreign"}}) {
            String chainPage = "resolution-chain-" + chain[0].replace(' ', '-') + "-" + chain[2] + ".html";
            List<String> chainRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            scenario(browser, engine, "progressiveresolution chained paints under a background-image transition, " +
                    chain[0] + ": " + ("foreign".equals(chain[2]) ? "an outranking writer still stands it down" :
                    "the host still upgrades after the transition"),
                Map.of("deviceScaleFactor", 1),
                context -> routeCheckPage(context, chainPage, checkPage(
                    "#cp-host{width:150px;height:150px;background-size:cover;" +
                    "background-image:url('/checks/cp-base-100x100.png');transition:background-image .3s " + chain[1] + "}" +
                    "#cp-host.cp-foreign{background-image:url('/checks/cp-foreign-300x300.png') !important}",
                    "<div id=\"cp-host\" data-paste-progressiveresolution data-image-sources=\"#cp-sources\"></div>" +
                    "<script type=\"application/json\" id=\"cp-sources\">{\"src\":\"/checks/cp-base-100x100.png\"," +
                    "\"width\":100,\"height\":100,\"upgrades\":[" +
                    "{\"src\":\"/checks/cp-up-200x200.png\",\"width\":200,\"height\":200}," +
                    "{\"src\":\"/checks/cp-up-400x400.png\",\"width\":400,\"height\":400}," +
                    "{\"src\":\"/checks/cp-up-800x800.png\",\"width\":800,\"height\":800}]}</script>",
                    RESOLUTION_SCRIPTS, null), chainRequests),
                (page, evidence) -> {
                    String inline = "() => document.getElementById('cp-host').style.backgroundImage";
                    String computed = "() => getComputedStyle(document.getElementById('cp-host')).backgroundImage";
                    String size = "(px) => { const h = document.getElementById('cp-host');" +
                        " h.style.width = px + 'px'; h.style.height = px + 'px'; }";
                    openCheckPage(page, chainPage);
                    awaitActive(page, "() => document.getElementById('cp-host').style.backgroundImage.includes('cp-up-200x200')");
                    page.evaluate(size, 350);
                    awaitActive(page, "() => document.getElementById('cp-host').style.backgroundImage.includes('cp-up-400x400')");
                    evidence.put("computedAtSecondPaint", page.evaluate(computed));
                    evidence.put("listedAtSecondPaint", page.evaluate("() => typeof Element.prototype.getAnimations !== 'function' ? null :" +
                        " document.getElementById('cp-host').getAnimations().map(a => a.transitionProperty || a.animationName || '')"));
                    // The transition reports the chained paint: the
                    // computed value is the module's last source alone.
                    page.waitForFunction("() => /^url\\(\"?[^,]*cp-up-400x400\\.png\"?\\)$/.test(" +
                        "getComputedStyle(document.getElementById('cp-host')).backgroundImage)",
                        null, new Page.WaitForFunctionOptions().setTimeout(8000));
                    frames(page);
                    if ("foreign".equals(chain[2])) {
                        page.evaluate("() => document.getElementById('cp-host').classList.add('cp-foreign')");
                        page.waitForFunction("() => /^url\\(\"?[^,]*cp-foreign-300x300\\.png\"?\\)$/.test(" +
                            "getComputedStyle(document.getElementById('cp-host')).backgroundImage)",
                            null, new Page.WaitForFunctionOptions().setTimeout(8000));
                        frames(page);
                        page.evaluate(size, 700);
                        page.waitForTimeout(1200);
                        page.evaluate(size, 1400);
                        page.waitForTimeout(1200);
                        evidence.put("inline", page.evaluate(inline));
                        evidence.put("computed", page.evaluate(computed));
                        evidence.put("requests", chainRequests);
                        require(chainRequests.stream().noneMatch(request -> request.contains("cp-up-800x800")),
                            "a host whose display another rule took still fetched an upgrade: " + chainRequests);
                        require(String.valueOf(page.evaluate(inline)).contains("cp-up-400x400"),
                            "a stood-down host kept painting: " + page.evaluate(inline));
                        return;
                    }
                    page.evaluate(size, 700);
                    boolean upgraded;
                    try {
                        page.waitForFunction("() => document.getElementById('cp-host').style.backgroundImage.includes('cp-up-800x800')",
                            null, new Page.WaitForFunctionOptions().setTimeout(4000));
                        upgraded = true;
                    } catch (PlaywrightException error) {
                        upgraded = false;
                    }
                    evidence.put("inline", page.evaluate(inline));
                    evidence.put("computed", page.evaluate(computed));
                    evidence.put("requests", chainRequests);
                    require(upgraded, "paints chained inside the transition cost the host its claim: inline " +
                        page.evaluate(inline) + ", requests " + chainRequests);
                    require(chainRequests.stream().anyMatch(request -> request.contains("cp-up-800x800")),
                        "the 800 rung was never requested: " + chainRequests);
                });
        }

        // form: the submit deadline runs on the module's own timer — an
        // engine may ignore an XHR timeout assigned after send — so a
        // stalled request releases its target, reports a timeout and
        // leaves the form free, while a replay-safe form keeps its native
        // replay. The stalled background request is held unanswered; a
        // native replay is answered so it can land.
        String[] formDeadlineScripts = {"/js/paste/paste.js", "/js/paste/util.js", "/js/paste/guid.js",
            "/js/paste/event.js", "/js/paste/io.js", "/js/paste/ui/form.js"};
        for (String kind : List.of("post", "idempotent post", "get")) {
            List<String> stallRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            scenario(browser, engine, "form deadline releases a stalled " + kind + " submit on the module timer", null,
                context -> {
                    routeCheckPage(context, "form-deadline.html", checkPage("",
                        "<div id=\"dl-reply\" data-paste-io-reply-fragment-target>" +
                        "<form data-paste-form data-paste-form-timeout=\"500\" action=\"/form-stall\" method=\"" +
                        (kind.equals("get") ? "get" : "post") + "\"" +
                        (kind.equals("idempotent post") ? " data-paste-form-idempotent" : "") + ">" +
                        "<input name=\"message\" value=\"hello\"><button name=\"intent\" value=\"save\">Send</button>" +
                        "</form></div>",
                        formDeadlineScripts,
                        "window.dlFailures = []; document.addEventListener('paste.ui.form:failed'," +
                        " e => dlFailures.push(e.detail.reason));"), null);
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-stall"), route -> {
                        stallRequests.add(route.request().resourceType() + " " + route.request().method());
                        if ("document".equals(route.request().resourceType())) {
                            route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                .setBody("<!DOCTYPE html><title>replayed</title><p id=\"dl-replayed\">Replayed</p>"));
                        }
                    });
                },
                (page, evidence) -> {
                    openCheckPage(page, "form-deadline.html");
                    verifyPageDependencies(page);
                    page.click("#dl-reply button");
                    awaitActive(page, "() => document.getElementById('dl-reply').getAttribute('aria-busy') === 'true'");
                    if (!kind.equals("post")) {
                        boolean replayed;
                        try {
                            page.waitForSelector("#dl-replayed", new Page.WaitForSelectorOptions().setTimeout(4000));
                            replayed = true;
                        } catch (PlaywrightException error) {
                            replayed = false;
                        }
                        evidence.put("url", page.url());
                        evidence.put("requests", List.copyOf(stallRequests));
                        require(replayed, "the expired " + kind + " never replayed natively: still at " + page.url() +
                            ", requests " + stallRequests);
                        require(stallRequests.size() == 2 && stallRequests.get(1).startsWith("document "),
                            "one background request then one native replay: " + stallRequests);
                        return;
                    }
                    try {
                        page.waitForFunction("() => dlFailures.length > 0", null,
                            new Page.WaitForFunctionOptions().setTimeout(4000));
                    } catch (PlaywrightException error) {
                        // The assertions below name what was left.
                    }
                    Object failures = page.evaluate("() => dlFailures.join(' ')");
                    Object busy = page.evaluate("() => document.getElementById('dl-reply').getAttribute('aria-busy')");
                    evidence.put("failures", failures);
                    evidence.put("busy", busy);
                    require("timeout".equals(failures), "a stalled submit past its 500 ms deadline reported [" + failures +
                        "], not a timeout");
                    require(busy == null, "the stalled submit still holds aria-busy=" + busy);
                    require(page.locator("#dl-reply .paste-ui-form-failure[role=alert]").count() == 1,
                        "the expired post shows the default notice");
                    page.click("#dl-reply button");
                    page.waitForCondition(() -> stallRequests.size() == 2,
                        new Page.WaitForConditionOptions().setTimeout(3000));
                    evidence.put("requests", List.copyOf(stallRequests));
                    require(stallRequests.size() == 2, "the next submit was swallowed: " + stallRequests);
                });
        }

        // form: an engine may abort the in-flight request as a navigation
        // starts; the module must never replay over the visitor's own
        // navigation. Each way of leaving lands where the visitor went,
        // with the one background request and no native replay.
        for (String leave : List.of("link", "location.href", "Back")) {
            for (String kind : List.of("idempotent post", "get")) {
                List<String> slowRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
                scenario(browser, engine, "form leaves a mid-submit " + leave + " navigation to the visitor (" + kind + ")", null,
                    context -> {
                        routeCheckPage(context, "form-leave.html", checkPage("",
                            "<div id=\"lv-reply\" data-paste-io-reply-fragment-target>" +
                            "<form data-paste-form action=\"/form-slow\" method=\"" + (kind.equals("get") ? "get" : "post") + "\"" +
                            (kind.equals("idempotent post") ? " data-paste-form-idempotent" : "") + ">" +
                            "<input name=\"message\" value=\"hello\"><button name=\"intent\" value=\"save\">Send</button>" +
                            "</form></div><a id=\"lv-away\" href=\"/form-away\">Away</a>",
                            formDeadlineScripts,
                            "document.addEventListener('paste.ui.form:failed', e => { try { sessionStorage.setItem('lvFailures'," +
                            " (sessionStorage.getItem('lvFailures') || '') + e.detail.reason + ' '); } catch (ignore) {} });"), null);
                        context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-slow"), route -> {
                            slowRequests.add(route.request().resourceType() + " " + route.request().method());
                            if ("document".equals(route.request().resourceType())) {
                                route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                    .setBody("<!DOCTYPE html><title>replayed</title><p id=\"lv-replayed\">Replayed</p>"));
                            }
                        });
                        context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-away"), route ->
                            route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                .setBody("<!DOCTYPE html><title>away</title><p id=\"lv-arrived\">Away</p>")));
                    },
                    (page, evidence) -> {
                        String destination = url + "form-away";
                        if (leave.equals("Back")) {
                            page.navigate(destination);
                        }
                        openCheckPage(page, "form-leave.html");
                        verifyPageDependencies(page);
                        page.click("#lv-reply button");
                        awaitActive(page, "() => document.getElementById('lv-reply').getAttribute('aria-busy') === 'true'");
                        page.waitForCondition(() -> slowRequests.size() == 1);
                        page.waitForTimeout(200);
                        try {
                            switch (leave) {
                                case "link" -> page.click("#lv-away", new Page.ClickOptions().setNoWaitAfter(true));
                                case "location.href" -> page.evaluate("d => { location.href = d; }", destination);
                                default -> page.goBack(new Page.GoBackOptions().setTimeout(5000));
                            }
                            page.waitForURL(destination, new Page.WaitForURLOptions().setTimeout(5000));
                        } catch (PlaywrightException error) {
                            evidence.put("navigationError", error.getMessage().split("\n")[0]);
                        }
                        // A replay the abort triggered would still be taking over.
                        page.waitForTimeout(1000);
                        String failures;
                        try {
                            failures = String.valueOf(page.evaluate("() => sessionStorage.getItem('lvFailures') || ''"));
                        } catch (PlaywrightException error) {
                            failures = "unreadable";
                        }
                        evidence.put("url", page.url());
                        evidence.put("requests", List.copyOf(slowRequests));
                        evidence.put("failures", failures);
                        require(page.url().equals(destination) && page.locator("#lv-arrived").count() == 1,
                            "the " + leave + " navigation landed at " + page.url() + ", not where the visitor went");
                        require(slowRequests.size() == 1,
                            "the server saw " + slowRequests + ", not the one background request");
                    });
            }
        }

        // form: an engine may fail the pending request as a network error,
        // not an abort, as a navigation starts — a download link among
        // them. The page stays, so the failure must end in the notice:
        // never a replay racing the visitor's navigation, never silence.
        for (String kind : List.of("idempotent post", "get")) {
            List<String> fileRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            List<String> pendingRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            scenario(browser, engine, "form never replays a submit a mid-submit download cut short (" + kind + ")", null,
                context -> {
                    routeCheckPage(context, "form-download.html", checkPage("",
                        "<div id=\"fd-reply\" data-paste-io-reply-fragment-target>" +
                        "<form data-paste-form action=\"/form-pending\" method=\"" + (kind.equals("get") ? "get" : "post") + "\"" +
                        (kind.equals("idempotent post") ? " data-paste-form-idempotent" : "") + ">" +
                        "<input name=\"message\" value=\"hello\"><button name=\"intent\" value=\"save\">Send</button>" +
                        "</form></div><a id=\"fd-file\" href=\"/form-file\">File</a>",
                        formDeadlineScripts,
                        "window.fdFailures = []; document.addEventListener('paste.ui.form:failed', e => fdFailures.push(e.detail.reason));"), null);
                    // The background request is held unanswered; a native
                    // replay is answered so it can land.
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-pending"), route -> {
                        pendingRequests.add(route.request().resourceType() + " " + route.request().method());
                        if ("document".equals(route.request().resourceType())) {
                            route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                .setBody("<!DOCTYPE html><title>replayed</title><p id=\"fd-replayed\">Replayed</p>"));
                        }
                    });
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-file"), route -> {
                        fileRequests.add(route.request().resourceType());
                        route.fulfill(new Route.FulfillOptions().setContentType("application/octet-stream")
                            .setHeaders(Map.of("content-disposition", "attachment; filename=report.bin")).setBody("bytes"));
                    });
                },
                (page, evidence) -> {
                    String formPage = url + "checks/form-download.html";
                    openCheckPage(page, "form-download.html");
                    verifyPageDependencies(page);
                    page.click("#fd-reply button");
                    awaitActive(page, "() => document.getElementById('fd-reply').getAttribute('aria-busy') === 'true'");
                    page.waitForCondition(() -> pendingRequests.size() == 1);
                    page.waitForTimeout(200);
                    page.click("#fd-file", new Page.ClickOptions().setNoWaitAfter(true));
                    page.waitForCondition(() -> !fileRequests.isEmpty(), new Page.WaitForConditionOptions().setTimeout(4000));
                    active(!fileRequests.isEmpty(), "the download link was followed");
                    // A replay the failure triggered would still be landing.
                    page.waitForTimeout(1500);
                    Map<?, ?> state;
                    try {
                        state = (Map<?, ?>) page.evaluate("() => ({failures: (window.fdFailures || []).join(' '), href: location.href," +
                            " notices: document.querySelectorAll('#fd-reply .paste-ui-form-failure[role=alert]').length," +
                            " busy: document.getElementById('fd-reply') ? document.getElementById('fd-reply').getAttribute('aria-busy') : 'gone'})");
                    } catch (PlaywrightException error) {
                        state = Map.of("unreadable", error.getMessage().split("\n")[0]);
                    }
                    evidence.put("state", state);
                    evidence.put("requests", List.copyOf(pendingRequests));
                    evidence.put("url", page.url());
                    require(page.url().equals(formPage), "the download left the page for " + page.url());
                    require(pendingRequests.size() == 1, "the server saw " + pendingRequests + ", not the one background request");
                    String failures = String.valueOf(state.get("failures"));
                    // An engine that keeps the request running is still busy
                    // and owes nothing yet; one that failed it shows why.
                    require(failures.isEmpty() ? "true".equals(state.get("busy"))
                            : ((Number) state.get("notices")).intValue() == 1 && state.get("busy") == null,
                        "a failed submit ended without the notice: " + state);
                });
        }

        // form: a beforeunload the visitor answers by staying ends with the
        // prompt — a later stop or network failure keeps the replay rule —
        // while a navigation the visitor confirms at the prompt is never
        // replayed over, even where the engine aborts the request as it
        // starts. The page's guard asks once.
        for (String kind : List.of("idempotent post", "get")) {
            for (boolean stays : List.of(true, false)) {
                List<String> guardRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
                List<String> dialogs = new java.util.concurrent.CopyOnWriteArrayList<>();
                String name = stays
                    ? "form keeps its replay once the visitor stays through a beforeunload prompt (" + kind + ")"
                    : "form never replays over a navigation confirmed at a beforeunload prompt (" + kind + ")";
                scenario(browser, engine, name, null,
                    context -> {
                        routeCheckPage(context, "form-guard.html", checkPage("",
                            "<div id=\"fg-reply\" data-paste-io-reply-fragment-target>" +
                            "<form data-paste-form action=\"/form-guarded\" method=\"" + (kind.equals("get") ? "get" : "post") + "\"" +
                            (kind.equals("idempotent post") ? " data-paste-form-idempotent" : "") + ">" +
                            "<input name=\"message\" value=\"hello\"><button name=\"intent\" value=\"save\">Send</button>" +
                            "</form></div><a id=\"fg-away\" href=\"/form-guard-away\">Away</a>",
                            formDeadlineScripts,
                            "const fgGuard = e => { e.preventDefault(); e.returnValue = ''; removeEventListener('beforeunload', fgGuard); };" +
                            " addEventListener('beforeunload', fgGuard);"), null);
                        context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-guarded"), route -> {
                            guardRequests.add(route.request().resourceType() + " " + route.request().method());
                            if ("document".equals(route.request().resourceType())) {
                                route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                    .setBody("<!DOCTYPE html><title>replayed</title><p id=\"fg-replayed\">Replayed</p>"));
                            }
                        });
                        context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-guard-away"), route ->
                            route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                                .setBody("<!DOCTYPE html><title>away</title><p id=\"fg-arrived\">Away</p>")));
                    },
                    (page, evidence) -> {
                        String formPage = url + "checks/form-guard.html";
                        String destination = url + "form-guard-away";
                        page.onDialog(dialog -> {
                            dialogs.add(dialog.type());
                            if (stays) dialog.dismiss(); else dialog.accept();
                        });
                        openCheckPage(page, "form-guard.html");
                        verifyPageDependencies(page);
                        page.click("#fg-reply button");
                        awaitActive(page, "() => document.getElementById('fg-reply').getAttribute('aria-busy') === 'true'");
                        page.waitForCondition(() -> guardRequests.size() == 1);
                        page.waitForTimeout(200);
                        page.click("#fg-away", new Page.ClickOptions().setNoWaitAfter(true));
                        page.waitForCondition(() -> !dialogs.isEmpty(), new Page.WaitForConditionOptions().setTimeout(4000));
                        active(dialogs.contains("beforeunload"), "the page's guard prompted: " + dialogs);
                        if (stays) {
                            // Well past the prompt: the visitor is still here.
                            page.waitForTimeout(1200);
                            require(page.url().equals(formPage), "the dismissed prompt still left for " + page.url());
                            require("true".equals(page.evaluate("() => document.getElementById('fg-reply').getAttribute('aria-busy')")),
                                "the background request did not survive the dismissed prompt");
                            // The visitor stops the page load: the stop aborts
                            // the request, which keeps its replay.
                            page.evaluate("() => { window.stop(); }");
                            boolean replayed;
                            try {
                                page.waitForSelector("#fg-replayed", new Page.WaitForSelectorOptions().setTimeout(4000));
                                replayed = true;
                            } catch (PlaywrightException error) {
                                replayed = false;
                            }
                            evidence.put("url", page.url());
                            evidence.put("requests", List.copyOf(guardRequests));
                            require(replayed, "an abort after the visitor stayed lost its replay: at " + page.url() +
                                ", requests " + guardRequests);
                            require(guardRequests.size() == 2 && guardRequests.get(1).startsWith("document "),
                                "one background request then one native replay: " + guardRequests);
                            return;
                        }
                        try {
                            page.waitForURL(destination, new Page.WaitForURLOptions().setTimeout(5000));
                        } catch (PlaywrightException error) {
                            evidence.put("navigationError", error.getMessage().split("\n")[0]);
                        }
                        page.waitForTimeout(1000);
                        evidence.put("url", page.url());
                        evidence.put("requests", List.copyOf(guardRequests));
                        require(page.url().equals(destination) && page.locator("#fg-arrived").count() == 1,
                            "the confirmed navigation landed at " + page.url() + ", not where the visitor went");
                        require(guardRequests.size() == 1, "the server saw " + guardRequests + ", not the one background request");
                    });
            }
        }

        // Fragment links stay native browser navigation: the address,
        // :target, hashchange and history are the browser's, the section
        // nav stylesheet's zero-specificity target clearance lands each
        // target at the stuck nav's bottom, and smoothscroll only moves
        // focus once the navigation has landed. The clearance rule is read
        // from the mixin source, its auto default resolved from the
        // mixin's own height and bottom-border defaults; a mixin without
        // the rule leaves the page with no clearance at all.
        String fragmentClearanceRule;
        String fragmentNavHeight;
        String fragmentNavBorder;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher height = Pattern.compile("\\$height:\\s*([0-9.]+px)").matcher(mixin);
            Matcher border = Pattern.compile("\\$border-bottom:\\s*([0-9.]+px)").matcher(mixin);
            fragmentNavHeight = height.find() ? height.group(1) : "50px";
            fragmentNavBorder = border.find() ? border.group(1) : "1px";
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            fragmentClearanceRule = rule.find()
                ? rule.group(1) + "{" + rule.group(2) + "calc(" + fragmentNavHeight + " + " + fragmentNavBorder + ")" + rule.group(3) + "}"
                : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
        String[] fragmentScripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
            "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/stickynav.js",
            "/js/paste/ui/smoothscroll.js"};
        String fragmentPage = checkPage(
            "html{scroll-behavior:auto}" + fragmentClearanceRule +
            ".paste-ui-section-nav{background:#fff;border-bottom:" + fragmentNavBorder + " solid #ccc}" +
            ".paste-ui-section-nav-items{display:flex;height:" + fragmentNavHeight + ";margin:0;padding:0;list-style:none}" +
            ".fn-slot{height:calc(" + fragmentNavHeight + " + " + fragmentNavBorder + ")}" +
            ".paste-fixed-subnav .sticky-nav-target{position:fixed;top:0;left:0;right:0;z-index:2}" +
            "#fn-intro{height:300px}section{height:1200px}#fn-note{display:none;height:400px}#fn-note:target{display:block}" +
            "#fn-tail{height:3000px}",
            "<div id=\"fn-intro\">intro</div><div class=\"fn-slot\">" +
            "<nav id=\"fn-nav\" class=\"paste-ui-section-nav sticky-nav-target\" aria-label=\"Sections\">" +
            "<ul class=\"paste-ui-section-nav-items\">" +
            "<li class=\"paste-ui-section-nav-item\"><a id=\"fn-go-one\" class=\"paste-ui-section-nav-link\" href=\"#fn-one\">One</a></li>" +
            "<li class=\"paste-ui-section-nav-item\"><a id=\"fn-go-two\" class=\"paste-ui-section-nav-link\" href=\"#fn-two\">Two</a></li>" +
            "<li class=\"paste-ui-section-nav-item\"><a id=\"fn-go-note\" class=\"paste-ui-section-nav-link\" href=\"#fn-note\">Note</a></li>" +
            "<li class=\"paste-ui-section-nav-item\"><a id=\"fn-go-cafe\" class=\"paste-ui-section-nav-link\" href=\"#fn-café\">Café</a></li>" +
            "<li class=\"paste-ui-section-nav-item\"><a id=\"fn-go-inside\" class=\"paste-ui-section-nav-link\" href=\"#fn-inside\">Details</a></li>" +
            "</ul></nav></div>" +
            "<section id=\"fn-one\">One</section><section id=\"fn-two\">Two<input id=\"fn-two-field\" aria-label=\"Field\"></section>" +
            "<div id=\"fn-note\">revealed by :target</div><section id=\"fn-café\">Café</section>" +
            "<details id=\"fn-details\"><summary>More</summary><p id=\"fn-inside\">inside a closed details element</p></details>" +
            "<div id=\"fn-tail\">tail</div>",
            fragmentScripts,
            "window.fnHashChanges = []; addEventListener('hashchange', () => fnHashChanges.push(location.hash));");
        // The target's top against the stuck nav's bottom, once the
        // navigation has settled and the sticky nav has had its frame.
        String fragmentLanding = """
            id => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
              const target = document.getElementById(id);
              const nav = document.getElementById('fn-nav').getBoundingClientRect();
              resolve({hash: location.hash, top: target.getBoundingClientRect().top, navBottom: nav.bottom,
                stuck: document.documentElement.classList.contains('paste-fixed-subnav'),
                target: target.matches(':target'), focused: document.activeElement === target,
                active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
                hashChanges: fnHashChanges.slice(), length: history.length});
            }, 30))))
            """;

        scenario(browser, engine, "smoothscroll native fragment navigation lands below the sticky nav with history", null,
            context -> routeCheckPage(context, "fragment-nav.html", fragmentPage, null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-nav.html");
                Number startLength = (Number) page.evaluate("() => history.length");
                List<Map<?, ?>> landings = new ArrayList<>();
                String[][] clicks = {{"fn-go-one", "fn-one", "#fn-one"}, {"fn-go-two", "fn-two", "#fn-two"}};
                for (String[] click : clicks) {
                    page.click("#" + click[0]);
                    awaitActive(page, "id => document.activeElement === document.getElementById(id)", click[1]);
                    Map<?, ?> landed = (Map<?, ?>) page.evaluate(fragmentLanding, click[1]);
                    landings.add(landed);
                    require(click[2].equals(landed.get("hash")), "the click must put " + click[2] + " in the address: " + landed);
                    require(Boolean.TRUE.equals(landed.get("target")), click[2] + " must match :target after the click");
                    require(((List<?>) landed.get("hashChanges")).contains(click[2]), "the click must fire hashchange for " + click[2]);
                    require(Boolean.TRUE.equals(landed.get("stuck")), "precondition: the sticky nav is stuck at " + click[2]);
                    require(Math.abs(((Number) landed.get("top")).doubleValue() - ((Number) landed.get("navBottom")).doubleValue()) <= 1,
                        click[2] + " must land at the stuck nav's bottom: " + landed);
                }
                evidence.put("clicks", landings);
                require(((Number) page.evaluate("() => history.length")).intValue() == startLength.intValue() + 2,
                    "each clicked fragment must add one history entry");

                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === '#fn-one'");
                Map<?, ?> back = (Map<?, ?>) page.evaluate(fragmentLanding, "fn-one");
                evidence.put("back", back);
                require(Boolean.TRUE.equals(back.get("target")) &&
                    Math.abs(((Number) back.get("top")).doubleValue() - ((Number) back.get("navBottom")).doubleValue()) <= 1,
                    "Back must return to the first fragment below the nav: " + back);
                page.evaluate("() => history.forward()");
                page.waitForFunction("() => location.hash === '#fn-two'");
                Map<?, ?> forward = (Map<?, ?>) page.evaluate(fragmentLanding, "fn-two");
                evidence.put("forward", forward);
                require(Boolean.TRUE.equals(forward.get("target")) &&
                    Math.abs(((Number) forward.get("top")).doubleValue() - ((Number) forward.get("navBottom")).doubleValue()) <= 1,
                    "Forward must return to the second fragment below the nav: " + forward);

                // A section only :target reveals shows, lands and takes focus.
                page.click("#fn-go-note");
                page.waitForFunction("() => document.activeElement === document.getElementById('fn-note')");
                Map<?, ?> note = (Map<?, ?>) page.evaluate(fragmentLanding, "fn-note");
                evidence.put("revealed", note);
                require(Boolean.TRUE.equals(page.evaluate("() => getComputedStyle(document.getElementById('fn-note')).display === 'block'")),
                    "the :target-revealed section must show");
                require(Math.abs(((Number) note.get("top")).doubleValue() - ((Number) note.get("navBottom")).doubleValue()) <= 1,
                    "the revealed section must land below the nav: " + note);

                // An encoded fragment focuses its decoded id; the fragment
                // already current focuses again without a new entry.
                page.click("#fn-go-cafe");
                page.waitForFunction("() => document.activeElement === document.getElementById('fn-café')");
                Number cafeLength = (Number) page.evaluate("() => history.length");
                page.focus("#fn-two-field");
                page.click("#fn-go-cafe");
                page.waitForFunction("() => document.activeElement === document.getElementById('fn-café')");
                require(((Number) page.evaluate("() => history.length")).intValue() == cafeLength.intValue(),
                    "the fragment already current must not add a history entry");
                evidence.put("cafe", page.evaluate(fragmentLanding, "fn-café"));

                // Reveal of a closed details element is the engine's: where
                // it reveals, the target lands and takes focus. Where it does
                // not, an engine may still focus the hidden target (WebKit)
                // or refuse; the borrowed tabindex stays only while focus does.
                boolean revealSupported = Boolean.TRUE.equals(page.evaluate("() => 'onbeforematch' in document.body"));
                page.click("#fn-go-inside");
                page.waitForFunction("() => location.hash === '#fn-inside'");
                Map<?, ?> inside = (Map<?, ?>) page.evaluate(fragmentLanding, "fn-inside");
                evidence.put("detailsRevealSupported", revealSupported);
                evidence.put("details", inside);
                evidence.put("detailsOpen", page.evaluate("() => document.getElementById('fn-details').open"));
                if (revealSupported) {
                    require(Boolean.TRUE.equals(page.evaluate("() => document.getElementById('fn-details').open")) &&
                        Boolean.TRUE.equals(inside.get("focused")),
                        "an engine that reveals closed details must open it and focus the target: " + inside);
                } else {
                    require(Boolean.TRUE.equals(page.evaluate("() => document.getElementById('fn-inside').hasAttribute('tabindex') ===" +
                        " (document.activeElement === document.getElementById('fn-inside'))")),
                        "a target the engine leaves hidden must keep a borrowed tabindex only while it holds focus");
                }
            });

        scenario(browser, engine, "smoothscroll native fragment navigation lands a loaded fragment below the sticky nav", null,
            context -> routeCheckPage(context, "fragment-nav.html", fragmentPage, null),
            (page, evidence) -> {
                Response navigation = page.navigate(url + "checks/fragment-nav.html#fn-two",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "regression page fragment-nav.html loads");
                awaitActive(page, "() => document.documentElement.classList.contains('paste-fixed-subnav')");
                Map<?, ?> landed = (Map<?, ?>) page.evaluate(fragmentLanding, "fn-two");
                evidence.put("loaded", landed);
                require(Boolean.TRUE.equals(landed.get("target")), "the loaded fragment must match :target");
                require(Math.abs(((Number) landed.get("top")).doubleValue() - ((Number) landed.get("navBottom")).doubleValue()) <= 1,
                    "a page loaded with a fragment must land it at the stuck nav's bottom: " + landed);
            });

        // An ordinary in-page link changes the fragment without touching
        // multistate's selection; traversing back to the page's first
        // entry restores the authored defaults.
        scenario(browser, engine, "smoothscroll native fragment navigation keeps multistate's selection", null,
            context -> routeCheckPage(context, "fragment-multistate.html", checkPage(
                "[data-multistate-value]{display:none}[data-multistate-state]{display:block}section{height:1500px}",
                "<input id=\"fm-a\" type=\"radio\" data-multistate-key=\"area1\" value=\"a\" checked><label for=\"fm-a\">A</label>" +
                "<input id=\"fm-b\" type=\"radio\" data-multistate-key=\"area1\" value=\"b\"><label for=\"fm-b\">B</label>" +
                "<div data-multistate-key=\"area1\" data-multistate-value=\"a\">panel a</div>" +
                "<div data-multistate-key=\"area1\" data-multistate-value=\"b\">panel b</div>" +
                "<nav class=\"paste-ui-section-nav\"><a id=\"fm-go\" href=\"#fm-section\">Section</a></nav>" +
                "<section>gap</section><section id=\"fm-section\">Section</section>",
                new String[]{"/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
                    "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/ui/multistate.js", "/js/paste/ui/smoothscroll.js"},
                null), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-multistate.html");
                String selection = "() => ({checked: document.querySelector('input[data-multistate-key=area1]:checked')?.value ?? null," +
                    " shown: document.querySelector('[data-multistate-key=area1][data-multistate-state]')?.getAttribute('data-multistate-value') ?? null," +
                    " hash: decodeURIComponent(location.hash)})";
                page.click("#fm-b");
                page.waitForFunction("() => decodeURIComponent(location.hash) === '#area1:b'");
                page.click("#fm-go");
                awaitActive(page, "() => document.activeElement === document.getElementById('fm-section')");
                Map<?, ?> afterLink = (Map<?, ?>) page.evaluate(selection);
                evidence.put("afterLink", afterLink);
                require("#fm-section".equals(afterLink.get("hash")), "the in-page link must navigate natively");
                require("b".equals(afterLink.get("checked")) && "b".equals(afterLink.get("shown")),
                    "an in-page link must keep the selected tab: " + afterLink);
                page.evaluate("() => history.back()");
                page.waitForFunction("() => decodeURIComponent(location.hash) === '#area1:b'");
                Map<?, ?> back = (Map<?, ?>) page.evaluate(selection);
                evidence.put("back", back);
                require("b".equals(back.get("checked")) && "b".equals(back.get("shown")), "Back to the tab entry must keep its tab: " + back);
                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === ''");
                page.waitForFunction("() => document.querySelector('input[data-multistate-key=area1]:checked')?.value === 'a'");
                evidence.put("first", page.evaluate(selection));
            });

        // data-hero-hashclick navigates natively to the next hero: a
        // fragment navigation to a hero with an id, a history entry and a
        // scroll to one without, and a scroll when the address already
        // names it.
        scenario(browser, engine, "heroscroll hash click navigates natively to the next hero", null,
            context -> routeCheckPage(context, "hero-hashclick.html", checkPage(
                "html{scroll-behavior:auto}.paste-ui-hero{position:relative;height:700px;margin:0}" +
                ".paste-ui-hero-content{padding:40px}#hh-tail{height:3000px}",
                "<section id=\"hh-one\" class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one</div></section>" +
                "<section id=\"hh-two\" class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>" +
                "<section class=\"paste-ui-hero\" id=\"\"><div class=\"paste-ui-hero-content\">three</div></section>" +
                "<div id=\"hh-tail\">tail</div>",
                HEROSCROLL_SCRIPTS,
                "window.hhHashChanges = []; addEventListener('hashchange', () => hhHashChanges.push(location.hash));"), null),
            (page, evidence) -> {
                openCheckPage(page, "hero-hashclick.html");
                String heroTop = "n => document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top";
                Number startLength = (Number) page.evaluate("() => history.length");
                page.click("#hh-one", new Page.ClickOptions().setPosition(20, 10));
                awaitActive(page, "() => location.hash === '#hh-two'");
                page.waitForFunction("() => hhHashChanges.includes('#hh-two')");
                Map<?, ?> first = (Map<?, ?>) page.evaluate("() => ({hash: location.hash, target: document.getElementById('hh-two').matches(':target')," +
                    " top: document.getElementById('hh-two').getBoundingClientRect().top, length: history.length, hashChanges: hhHashChanges.slice()})");
                evidence.put("toIdentified", first);
                require(Boolean.TRUE.equals(first.get("target")), "the next hero must match :target");
                require(Math.abs(((Number) first.get("top")).doubleValue()) <= 1, "the next hero must reach the viewport top: " + first);
                require(((Number) first.get("length")).intValue() == startLength.intValue() + 1, "the fragment navigation must add a history entry");

                page.click("#hh-two", new Page.ClickOptions().setPosition(20, 10));
                page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top) <= 1", 2);
                Map<?, ?> unidentified = (Map<?, ?>) page.evaluate("() => ({hash: location.hash, length: history.length," +
                    " top: document.querySelectorAll('.paste-ui-hero')[2].getBoundingClientRect().top})");
                evidence.put("toUnidentified", unidentified);
                require("".equals(unidentified.get("hash")) && ((Number) unidentified.get("length")).intValue() == startLength.intValue() + 2,
                    "a hero without an id must get its own entry, without the fragment of the hero it left: " + unidentified);

                page.evaluate("() => window.scrollTo(0, 0)");
                page.waitForFunction("() => scrollY === 0");
                page.click("#hh-one", new Page.ClickOptions().setPosition(20, 10));
                page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top) <= 1", 1);
                evidence.put("toCurrent", page.evaluate("() => ({hash: location.hash, top: document.getElementById('hh-two').getBoundingClientRect().top, length: history.length})"));
                require(((Number) page.evaluate(heroTop, 1)).doubleValue() <= 1,
                    "a hash click to the fragment already current must still reach the next hero");
            });
    }

    // imagesequence background claims, baseline adoption and decode
    // checks under real transitions and real vector decodes.
    private static void imagesequenceClaimAndDecodeRegressions(Browser browser, String engine) {
        String sequenceSettled = "([id, name]) => { const v = getComputedStyle(document.getElementById(id)).backgroundImage;" +
            " const m = new RegExp('^url\\\\(\"?[^\")]*' + name + '-frame-(\\\\d+)-([0-9x]+)\\\\.png\"?\\\\)$').exec(v);" +
            " return m ? m[1] + '@' + m[2] : v; }";

        // An !important stylesheet rule outranks the inline frame, and a
        // declared transition never starts because the computed value
        // never changes. Where the platform lists animations that list is
        // the evidence: the refused paint reverts on its first read and
        // asks for no further frames.
        scenario(browser, engine, "imagesequence reverts a paint an !important rule outranks without polling frames", null,
            context -> routeCheckPage(context, "sequence-refused-paint.html", checkPage(
                ".ir-pad{height:100vh}#ir-band{height:300vh;position:relative}" +
                "#ir-scene{position:sticky;top:0;height:100vh}" +
                "#ir-host{display:block;width:640px;height:360px;background-size:cover;" +
                "background-image:url('/checks/ir-frame-0-320x180.png') !important;transition:all .3s linear}",
                "<script>window.irFrames = 0; (function () { const request = window.requestAnimationFrame.bind(window);" +
                " window.requestAnimationFrame = function (callback) { window.irFrames += 1; return request(callback); }; })();</script>" +
                "<div class=\"ir-pad\"></div><section id=\"ir-band\"><div id=\"ir-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#ir-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"ir-host\" data-paste-imagesequence=\"#ir-frames\" data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                "<script type=\"application/json\" id=\"ir-frames\">" + catalogJson("ir", 8, 320, 180, 0, 0) + "</script>" +
                "</div></section><div class=\"ir-pad\"></div>",
                SEQUENCE_SCRIPTS,
                "window.irWrites = []; (function () { const h = document.getElementById('ir-host');" +
                " new MutationObserver(function () { const m = /ir-frame-(\\d+)-/.exec(h.style.backgroundImage);" +
                " window.irWrites.push(m ? Number(m[1]) : -1); }).observe(h, {attributes: true, attributeFilter: ['style']}); })();"),
                null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-refused-paint.html");
                page.waitForTimeout(500);
                Number before = (Number) page.evaluate("() => window.irFrames");
                page.evaluate("() => { const b = document.getElementById('ir-band').getBoundingClientRect();" +
                    " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * 0.5); }");
                page.waitForTimeout(1500);
                int frames = ((Number) page.evaluate("() => window.irFrames")).intValue() - before.intValue();
                List<?> writes = (List<?>) page.evaluate("() => window.irWrites");
                evidence.put("framesIn1500ms", frames);
                evidence.put("writes", writes);
                evidence.put("listsAnimations", page.evaluate("() => typeof Element.prototype.getAnimations === 'function'"));
                active(!writes.isEmpty() && ((Number) writes.get(0)).intValue() > 0, "the scrub wrote a frame");
                require(writes.size() >= 2 && ((Number) writes.get(writes.size() - 1)).intValue() == -1,
                    "the paint an !important rule outranks was not reverted within 1.5 s: " + writes);
                require(frames < 30, "a refused paint kept requesting frames: " + frames + " in 1.5 s");
            });

        // Reduced motion restores the stylesheet poster through a
        // background-image transition. The computed value is the
        // transition's until it ends, so adoption waits for it, and the
        // adopted initial frame zero still sharpens at device ratio 2.
        scenario(browser, engine, "imagesequence re-adopts and sharpens the poster after a reduced-motion cross-fade",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "sequence-motion-crossfade.html", checkPage(
                "#rm-band{height:300vh;position:relative}#rm-scene{position:sticky;top:0;height:100vh}" +
                ".rm-pad{height:100vh}" +
                "#rm-host{display:block;width:640px;height:360px;background-size:cover;" +
                "background-image:url('/checks/rm-frame-0-640x360.png');transition:all .3s linear}",
                "<section id=\"rm-band\"><div id=\"rm-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#rm-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"rm-host\" data-paste-imagesequence=\"#rm-frames\" data-paste-progressiveresolution" +
                " data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                "<script type=\"application/json\" id=\"rm-frames\">" + catalogJson("rm", 8, 640, 360, 1280, 720) + "</script>" +
                "</div></section><div class=\"rm-pad\"></div>",
                SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-motion-crossfade.html");
                page.evaluate("() => { const b = document.getElementById('rm-band').getBoundingClientRect();" +
                    " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * 0.6); }");
                page.waitForTimeout(200);
                int expected = expectedIndex(0, 7, property(page, "#rm-scene"));
                evidence.put("scrubbedTo", expected);
                awaitActive(page, "want => (" + sequenceSettled + ")(['rm-host', 'rm']) === want",
                    expected + "@1280x720", new Page.WaitForFunctionOptions().setTimeout(5000));
                page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.REDUCE));
                boolean sharpened;
                try {
                    page.waitForFunction("() => (" + sequenceSettled + ")(['rm-host', 'rm']) === '0@1280x720'",
                        null, new Page.WaitForFunctionOptions().setTimeout(4000));
                    sharpened = true;
                } catch (PlaywrightException timeout) {
                    sharpened = false;
                }
                evidence.put("poster", page.evaluate("() => (" + sequenceSettled + ")(['rm-host', 'rm'])"));
                evidence.put("inline", page.evaluate("() => document.getElementById('rm-host').style.backgroundImage"));
                require(sharpened, "the restored poster was not re-adopted and sharpened after the cross-fade: " +
                    evidence.get("poster"));
            });

        // A sharper rung needed while a fresh claim is still pending —
        // the host grows inside a one-second background-image transition
        // — is painted once that claim settles, with no further input.
        scenario(browser, engine, "imagesequence paints a rung needed while its claim is pending without further input", null,
            context -> routeCheckPage(context, "sequence-pending-rung.html", checkPage(
                ".pc-pad{height:100vh}#pc-band{height:300vh;position:relative}" +
                "#pc-scene{position:sticky;top:0;height:100vh}" +
                "#pc-host{display:block;width:320px;height:180px;background-size:cover;" +
                "background-image:url('/checks/pc-frame-0-320x180.png');transition:background-image 1s linear}" +
                "#pc-host.pc-big{width:1000px;height:562px}",
                "<div class=\"pc-pad\"></div><section id=\"pc-band\"><div id=\"pc-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#pc-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"pc-host\" data-paste-imagesequence=\"#pc-frames\" data-paste-progressiveresolution" +
                " data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                "<script type=\"application/json\" id=\"pc-frames\">" + catalogJson("pc", 8, 320, 180, 1280, 720) + "</script>" +
                "</div></section><div class=\"pc-pad\"></div>",
                SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                // Both waits run on the page's frame clock: a pass needs a
                // frame, so an overloaded host that withholds frames only
                // delays the end state. The deadline — 600 frames and 15 s
                // of document timeline, several times the two one-second
                // transitions — is reached only by a page that kept
                // animating, and its diagnostics say which side stalled.
                String transitionState = "() => { const h = document.getElementById('pc-host');" +
                    " return {settled: (" + sequenceSettled + ")(['pc-host', 'pc'])," +
                    " computed: getComputedStyle(h).backgroundImage, inline: h.style.backgroundImage," +
                    " width: h.getBoundingClientRect().width," +
                    " transitions: typeof h.getAnimations !== 'function' ? 'unlisted' : h.getAnimations().map(a =>" +
                    " ({property: a.transitionProperty, playState: a.playState, currentTime: a.currentTime," +
                    " startTime: a.startTime, progress: a.effect ? a.effect.getComputedTiming().progress : null}))}; }";
                java.util.function.Function<Map<String, Object>, String> stalled = wait ->
                    wait.get("frames") + " frames delivered, document.timeline.currentTime " +
                    wait.get("timelineStart") + " -> " + wait.get("timelineEnd") + ", " + wait.get("wallMs") +
                    " ms wall, ended by " + wait.get("ended") + "; transition state " + wait.get("state");
                openCheckPage(page, "sequence-pending-rung.html");
                page.waitForTimeout(300);
                page.evaluate("() => { const b = document.getElementById('pc-band').getBoundingClientRect();" +
                    " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * 0.45); }");
                Map<String, Object> scrubbed = awaitInFrames(page,
                    "() => /pc-frame-[1-7]-320x180/.test(document.getElementById('pc-host').style.backgroundImage)",
                    null, 600, 15000, transitionState, 180000);
                evidence.put("scrubWait", scrubbed);
                active(Boolean.TRUE.equals(scrubbed.get("reached")),
                    "the scrub painted a frame past the poster from the small rung" +
                    (Boolean.TRUE.equals(scrubbed.get("reached")) ? "" : ": " + stalled.apply(scrubbed)));
                String painted = String.valueOf(page.evaluate("() => /pc-frame-(\\d+)-/.exec(" +
                    "document.getElementById('pc-host').style.backgroundImage)[1]"));
                evidence.put("whenNeeded", page.evaluate("() => { document.getElementById('pc-host').classList.add('pc-big');" +
                    " return (" + transitionState + ")(); }"));
                evidence.put("frame", painted);
                Map<String, Object> sharpened = awaitInFrames(page,
                    "want => (" + sequenceSettled + ")(['pc-host', 'pc']) === want",
                    painted + "@1280x720", 600, 15000, transitionState, 180000);
                evidence.put("sharpenWait", sharpened);
                evidence.put("settled", ((Map<?, ?>) sharpened.get("state")).get("settled"));
                require(Boolean.TRUE.equals(sharpened.get("reached")),
                    "the rung needed while the claim was pending was never painted: " + evidence.get("settled") +
                    " after " + stalled.apply(sharpened));
            });

        // viewBox-only SVG frames report no pixel size of their own — one
        // engine reads 0x0, another a default box — so the decoded-size
        // check never refuses them and the scrub reaches its frame.
        List<String> vectorRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
        StringBuilder vectorCatalog = new StringBuilder("{\"frames\":[");
        for (int index = 0; index < 8; index += 1) {
            if (index > 0) vectorCatalog.append(',');
            vectorCatalog.append("{\"src\":\"/checks/sv-frame-").append(index)
                .append(".svg\",\"width\":640,\"height\":360}");
        }
        vectorCatalog.append("]}");
        scenario(browser, engine, "imagesequence paints viewBox-only SVG frames", null,
            context -> {
                routeCheckPage(context, "sequence-svg.html", checkPage(
                    ".sv-pad{height:100vh}#sv-band{height:300vh;position:relative}" +
                    "#sv-scene{position:sticky;top:0;height:100vh}" +
                    "#sv-host{display:block;width:640px;height:360px;background-size:cover;" +
                    "background-image:url('/checks/sv-frame-0.svg')}",
                    "<div class=\"sv-pad\"></div><section id=\"sv-band\"><div id=\"sv-scene\" data-paste-scrollscrub" +
                    " data-scrub-subject=\"#sv-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                    "<i id=\"sv-host\" data-paste-imagesequence=\"#sv-frames\" data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                    "<script type=\"application/json\" id=\"sv-frames\">" + vectorCatalog + "</script>" +
                    "</div></section><div class=\"sv-pad\"></div>",
                    SEQUENCE_SCRIPTS, null), null);
                vectorRequests.clear();
                context.route(requestUrl -> requestUrl.startsWith(url + "checks/sv-frame-") && requestUrl.endsWith(".svg"), route -> {
                    String requestUrl = route.request().url();
                    vectorRequests.add(requestUrl.substring(requestUrl.lastIndexOf('/') + 1));
                    int index = Integer.parseInt(requestUrl.replaceAll(".*sv-frame-(\\d+)\\.svg$", "$1"));
                    route.fulfill(new Route.FulfillOptions().setContentType("image/svg+xml").setBody(
                        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 640 360\"><rect width=\"640\" height=\"360\" fill=\"#" +
                        String.format("%06x", (index * 0x2a3b4c + 0x103050) & 0xffffff) + "\"/></svg>"));
                });
            },
            (page, evidence) -> {
                openCheckPage(page, "sequence-svg.html");
                page.evaluate("() => { const b = document.getElementById('sv-band').getBoundingClientRect();" +
                    " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * 0.6); }");
                page.waitForTimeout(200);
                int expected = expectedIndex(0, 7, property(page, "#sv-scene"));
                String settled = "() => { const m = /^url\\(\"?[^\")]*sv-frame-(\\d+)\\.svg\"?\\)$/.exec(" +
                    "getComputedStyle(document.getElementById('sv-host')).backgroundImage); return m ? Number(m[1]) : -1; }";
                boolean reached;
                try {
                    page.waitForFunction("want => (" + settled + ")() === want", expected,
                        new Page.WaitForFunctionOptions().setTimeout(3000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("expected", expected);
                evidence.put("painted", page.evaluate(settled));
                evidence.put("requests", List.copyOf(vectorRequests));
                boolean beyond = vectorRequests.stream().anyMatch(request -> !request.equals("sv-frame-0.svg"));
                evidence.put("decodedSize", page.evaluate("async () => { const i = new Image(); i.src = '/checks/sv-frame-1.svg';" +
                    " await i.decode(); return i.naturalWidth + 'x' + i.naturalHeight; }"));
                active(beyond, "the scrub requested frames beyond its baseline");
                require(reached, "the scrub never painted SVG frame " + expected + ": painted " + evidence.get("painted") +
                    ", decoded size " + evidence.get("decodedSize"));
            });
    }

    // Late and transformed geometry: what the scroll, marquee and hero
    // measurements must still get right when layout moves after bind,
    // when a box is fractional or scaled, and when the scroller a
    // declaration names is not the one that scrolls.
    private static void lateGeometryRegressions(Browser browser, String engine) {
        String[] scrubScripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/scrollrange.js",
            "/js/paste/ui/scrollscrub.js"};
        String progressOf = "s => document.querySelector(s).style.getPropertyValue('--paste-scrub-progress')";

        // A subject inside a fixed-height wrapper moves when content before
        // it inside the wrapper changes, while every box the root's own
        // content list watches keeps its size.
        scenario(browser, engine, "scrollscrub re-measures a subject when content changes inside a fixed-height wrapper", null,
            context -> routeCheckPage(context, "scrub-fixed-wrapper.html", checkPage(
                "html,body,#fw-app{height:100%}#fw-top{height:800px}#fw-scope{height:400px}#fw-bottom{height:2000px}",
                "<div id=\"fw-app\"><div id=\"fw-top\"></div><section id=\"fw-scope\" data-paste-scrollscrub></section>" +
                "<div id=\"fw-bottom\"></div></div>",
                scrubScripts, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-fixed-wrapper.html");
                String read = "() => { const s = document.getElementById('fw-scope'), vh = document.documentElement.clientHeight," +
                    " r = s.getBoundingClientRect(); return {published: parseFloat(s.style.getPropertyValue('--paste-scrub-progress'))," +
                    " truth: Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height)))}; }";
                page.evaluate("() => window.scrollTo(0, 600)");
                awaitActive(page, "() => { const x = (" + read + ")(); return Math.abs(x.published - x.truth) < 0.002; }");
                // Every bind-time observer delivery has landed before the
                // insertion, so only the insertion can re-measure.
                frames(page);
                page.waitForTimeout(400);
                frames(page);
                evidence.put("before", page.evaluate(read));
                page.evaluate("() => { const d = document.createElement('div'); d.style.height = '500px';" +
                    " document.getElementById('fw-app').insertBefore(d, document.getElementById('fw-scope')); }");
                frames(page);
                evidence.put("afterInsertScrollY", page.evaluate("() => scrollY"));
                evidence.put("afterInsertUnscrolled", page.evaluate(read));
                page.evaluate("() => window.scrollTo(0, 1100)");
                frames(page);
                page.waitForTimeout(100);
                Map<?, ?> after = (Map<?, ?>) page.evaluate(read);
                evidence.put("afterInsert", after);
                require(Math.abs(((Number) after.get("published")).doubleValue() - ((Number) after.get("truth")).doubleValue()) < 0.002,
                    "content inserted inside the fixed-height wrapper left stale endpoints: " + after);
            });

        // offsetHeight rounds a fractional root: the untransformed root must
        // not read the rounding as a scale. A root drawn at half size still
        // measures in its own scroll space.
        scenario(browser, engine, "scrollscrub keeps a fractional-height nested root's endpoints exact", null,
            context -> routeCheckPage(context, "scrub-fractional-root.html", checkPage(
                ".fr-scroller{position:relative;overflow-y:auto;scrollbar-width:none}.fr-scroller::-webkit-scrollbar{display:none}" +
                ".fr-top{height:4000px}.fr-scope{height:400px}.fr-bottom{height:3000px}#fr-a{height:300.5px}#fr-c{height:300px}" +
                "#fr-wrap{transform:scale(0.5);transform-origin:0 0}",
                "<div class=\"fr-scroller\" id=\"fr-a\"><div class=\"fr-top\"></div>" +
                "<section class=\"fr-scope\" id=\"fr-sa\" data-paste-scrollscrub data-scrub-root=\"#fr-a\"></section>" +
                "<div class=\"fr-bottom\"></div></div>" +
                "<div id=\"fr-wrap\"><div class=\"fr-scroller\" id=\"fr-c\"><div class=\"fr-top\"></div>" +
                "<section class=\"fr-scope\" id=\"fr-sc\" data-paste-scrollscrub data-scrub-root=\"#fr-c\"></section>" +
                "<div class=\"fr-bottom\"></div></div></div>",
                scrubScripts, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-fractional-root.html");
                awaitActive(page, "() => document.getElementById('fr-sa').style.getPropertyValue('--paste-scrub-progress') === '0'");
                frames(page);
                // The truth in the root's own layout units: the subject's
                // offset in the positioned scroller against its scrollTop.
                String truth = "ids => { const r = document.getElementById(ids[0]), s = document.getElementById(ids[1])," +
                    " start = s.offsetTop - r.clientHeight, end = s.offsetTop + s.offsetHeight;" +
                    " return {scrollTop: r.scrollTop, offsetHeight: r.offsetHeight, rendered: r.getBoundingClientRect().height," +
                    " published: parseFloat(s.style.getPropertyValue('--paste-scrub-progress'))," +
                    " truth: Math.min(1, Math.max(0, (r.scrollTop - start) / (end - start)))}; }";
                for (String[] ids : new String[][]{{"fr-a", "fr-sa"}, {"fr-c", "fr-sc"}}) {
                    List<Object> samples = new ArrayList<>();
                    for (int position : new int[]{3800, 3900, 4000, 4100, 4300}) {
                        page.evaluate("a => { document.getElementById(a[0]).scrollTop = a[1]; }", List.of(ids[0], position));
                        frames(page);
                        Map<?, ?> sample = (Map<?, ?>) page.evaluate(truth, List.of(ids[0], ids[1]));
                        samples.add(sample);
                        require(Math.abs(((Number) sample.get("published")).doubleValue() - ((Number) sample.get("truth")).doubleValue()) < 0.002,
                            "#" + ids[0] + " published a skewed progress: " + sample);
                    }
                    evidence.put(ids[0], samples);
                }
            });

        // body { overflow-x: hidden } computes the body's overflow-y to
        // auto, but with the root element's overflow visible the viewport
        // takes that overflow over: the body never scrolls, so a body root
        // must leave the authored baseline rather than a frozen number.
        scenario(browser, engine, "scrollscrub leaves a body root whose overflow the viewport takes over at its baseline", null,
            context -> routeCheckPage(context, "scrub-body-root.html", checkPage(
                "html,body{height:100%}body{overflow-x:hidden}.br-top{height:1000px}#br-scope,#br-control{height:400px}.br-bottom{height:2000px}",
                "<div class=\"br-top\"></div><section id=\"br-scope\" data-paste-scrollscrub data-scrub-root=\"body\"></section>" +
                "<section id=\"br-control\" data-paste-scrollscrub></section><div class=\"br-bottom\"></div>",
                scrubScripts, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-body-root.html");
                evidence.put("bodyOverflowY", page.evaluate("() => getComputedStyle(document.body).overflowY"));
                List<Object> samples = new ArrayList<>();
                for (int position : new int[]{0, 600, 900, 1200, 1600}) {
                    page.evaluate("y => window.scrollTo(0, y)", position);
                    frames(page);
                    samples.add(List.of(position, page.evaluate(progressOf, "#br-scope"), page.evaluate(progressOf, "#br-control")));
                }
                evidence.put("samples", samples);
                awaitActive(page, "() => parseFloat(document.getElementById('br-control').style.getPropertyValue('--paste-scrub-progress')) > 0");
                for (Object sample : samples) {
                    require("".equals(((List<?>) sample).get(1)),
                        "a body root the viewport scrolls for published a frozen progress: " + samples);
                }
            });

        // A scope naming itself as its root binds nothing and is reported
        // like any other invalid declaration. The page's timer is wrapped
        // before the module captures it, so the report is recorded rather
        // than surfacing as an uncaught error.
        scenario(browser, engine, "scrollscrub reports a scope that names itself as its root", null,
            context -> routeCheckPage(context, "scrub-self-root.html", checkPage(
                "#sr-root{height:300px;overflow-y:auto}#sr-control{height:400px}",
                "<script>window.scrubReports = []; (function () { var timer = window.setTimeout;" +
                " window.setTimeout = function (fn, ms) { return timer(function () { try { fn(); }" +
                " catch (error) { window.scrubReports.push(String(error && error.message)); } }, ms); }; }());</script>" +
                "<div id=\"sr-root\" data-paste-scrollscrub data-scrub-root=\"#sr-root\"><div style=\"height:2000px\"></div></div>" +
                "<section id=\"sr-control\" data-paste-scrollscrub></section><div style=\"height:3000px\"></div>",
                scrubScripts, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-self-root.html");
                awaitActive(page, "() => document.getElementById('sr-control').style.getPropertyValue('--paste-scrub-progress') !== ''");
                page.evaluate("() => { document.getElementById('sr-root').scrollTop = 500; window.scrollTo(0, 200); }");
                frames(page);
                page.waitForTimeout(100);
                List<?> reports = (List<?>) page.evaluate("() => window.scrubReports");
                Object written = page.evaluate(progressOf, "#sr-root");
                evidence.put("reports", reports);
                evidence.put("selfRootProgress", written);
                require("".equals(written), "a scope that is its own root published progress: " + written);
                require(reports.stream().anyMatch(report -> String.valueOf(report).contains("#sr-root") &&
                    String.valueOf(report).contains("not the root itself")), "the self-root scope was not reported: " + reports);
            });

        // The page's scroll moves a nested root and its subject together:
        // the endpoints in the root's scroll space stand, so a page scroll
        // reads no layout for the nested scope, and the root's own scroll
        // still moves its progress from the offset alone.
        scenario(browser, engine, "scrollscrub reads no layout for a nested root on page scroll", null,
            context -> routeCheckPage(context, "scrub-nested-page-scroll.html", checkPage(
                "#ns-root{height:400px;overflow-y:auto}#ns-scope{height:300px}",
                "<div style=\"height:1500px\"></div><div id=\"ns-root\"><div style=\"height:600px\"></div>" +
                "<section id=\"ns-scope\" data-paste-scrollscrub data-scrub-root=\"#ns-root\"></section>" +
                "<div style=\"height:1200px\"></div></div><div style=\"height:3000px\"></div>",
                scrubScripts, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-nested-page-scroll.html");
                page.waitForFunction("() => document.getElementById('ns-scope').style.getPropertyValue('--paste-scrub-progress') !== ''");
                frames(page);
                page.evaluate("() => { window.rectReads = 0; const read = Element.prototype.getBoundingClientRect;" +
                    " Element.prototype.getBoundingClientRect = function () { window.rectReads += 1; return read.call(this); }; }");
                for (int position : new int[]{200, 600, 1000, 1400, 1800}) {
                    page.evaluate("y => window.scrollTo(0, y)", position);
                    frames(page);
                }
                Number pageScrollReads = (Number) page.evaluate("() => window.rectReads");
                evidence.put("rectReadsOnPageScroll", pageScrollReads);
                require(pageScrollReads.intValue() == 0, "page scrolling re-measured a nested scope: " + pageScrollReads + " rectangle reads");
                String before = String.valueOf(page.evaluate(progressOf, "#ns-scope"));
                page.evaluate("() => { document.getElementById('ns-root').scrollTop = 500; }");
                awaitActive(page, "v => document.getElementById('ns-scope').style.getPropertyValue('--paste-scrub-progress') !== v", before);
                evidence.put("progress", List.of(before, page.evaluate(progressOf, "#ns-scope")));
                require(((Number) page.evaluate("() => window.rectReads")).intValue() == 0, "the root's own scroll read layout");
            });

        // The marquee module is read from this checkout's file and served
        // under checks/, so the page runs exactly the bytes under test.
        String[] marqueeScripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/mediaquery.js",
            "/checks/marquee-module.js"};
        Consumer<BrowserContext> marqueeModule = context -> context.route(url + "checks/marquee-module.js", route -> {
            try {
                route.fulfill(new Route.FulfillOptions().setContentType("text/javascript")
                    .setBodyBytes(Files.readAllBytes(Path.of("modules/marquee/marquee.js"))));
            } catch (Exception error) {
                route.abort();
            }
        });
        String marqueeCss =
            ".paste-ui-marquee{--paste-marquee-item-width:100px;--paste-marquee-item-height:40px;--paste-marquee-gap:16px;" +
            "--paste-marquee-inline-sign:1;box-sizing:border-box;contain:inline-size;display:block;inline-size:100%;min-inline-size:0;max-inline-size:100%}" +
            ".paste-ui-marquee-items{box-sizing:border-box;display:flex;flex-wrap:wrap;gap:var(--paste-marquee-gap);inline-size:100%;list-style:none;margin:0;padding:0}" +
            ".paste-ui-marquee-item{align-items:center;box-sizing:border-box;display:flex;flex:none;inline-size:min(100%,var(--paste-marquee-item-width));" +
            "justify-content:center;min-block-size:var(--paste-marquee-item-height);min-inline-size:0;background:#ddd}" +
            ".paste-ui-marquee-toggle{font:inherit}.paste-ui-marquee-toggle[hidden]{display:none}" +
            "@media (prefers-reduced-motion: no-preference){" +
            ".paste-ui-marquee[data-paste-marquee-state=\"running\"]>.paste-ui-marquee-items{block-size:var(--paste-marquee-row-height);display:block;overflow:hidden;position:relative}" +
            ".paste-ui-marquee[data-paste-marquee-state=\"running\"]>.paste-ui-marquee-items>.paste-ui-marquee-item{animation:paste-ui-marquee var(--paste-marquee-duration) linear infinite;" +
            "animation-delay:var(--paste-marquee-delay);inset-block-start:0;inset-inline-start:0;position:absolute;will-change:transform}}" +
            "@keyframes paste-ui-marquee{from{transform:translate3d(calc(var(--paste-marquee-inline-sign) * (var(--paste-marquee-distance) - var(--paste-marquee-item-size))),0,0)}" +
            "to{transform:translate3d(calc(var(--paste-marquee-inline-sign) * (0px - var(--paste-marquee-item-size))),0,0)}}";
        StringBuilder marqueeItems = new StringBuilder();
        for (int item = 1; item <= 12; item += 1) marqueeItems.append("<li class=\"paste-ui-marquee-item\">").append(item).append("</li>");
        String marquee = "<div class=\"paste-ui-marquee\" id=\"mq\" data-paste-marquee data-paste-marquee-duration=\"45\">" +
            "<ul class=\"paste-ui-marquee-items\">" + marqueeItems + "</ul>" +
            "<button class=\"paste-ui-marquee-toggle\" type=\"button\">Pause</button></div>";
        String marqueeRead = "() => { const root = document.getElementById('mq'), list = root.firstElementChild," +
            " lefts = Array.from(list.children, item => item.getBoundingClientRect().left)," +
            " distance = parseFloat(list.style.getPropertyValue('--paste-marquee-distance'))," +
            " scale = list.getBoundingClientRect().width / list.offsetWidth;" +
            " return {state: root.getAttribute('data-paste-marquee-state'), columnGap: getComputedStyle(list).columnGap," +
            " distance: list.style.getPropertyValue('--paste-marquee-distance')," +
            " itemSize: list.style.getPropertyValue('--paste-marquee-item-size'), itemWidth: list.children[0].offsetWidth," +
            " pitch: (((lefts[1] - lefts[0]) / scale) % distance + distance) % distance}; }";

        // A breakpoint that changes the authored gap while the list runs
        // changes the running pitch with it, in both directions.
        scenario(browser, engine, "marquee running pitch follows a breakpoint gap change", null,
            context -> {
                routeCheckPage(context, "marquee-gap.html", checkPage(
                    marqueeCss + "@media (max-width: 800px){.paste-ui-marquee{--paste-marquee-gap:48px}}",
                    marquee, marqueeScripts, null), null);
                marqueeModule.accept(context);
            },
            (page, evidence) -> {
                openCheckPage(page, "marquee-gap.html");
                awaitActive(page, "() => document.getElementById('mq').getAttribute('data-paste-marquee-state') === 'running'");
                Map<?, ?> wide = (Map<?, ?>) page.evaluate(marqueeRead);
                evidence.put("wide", wide);
                require("1392px".equals(wide.get("distance")), "the bind-time pitch is not 12 x (100 + 16): " + wide);
                page.setViewportSize(700, 900);
                page.waitForTimeout(150);
                frames(page);
                Map<?, ?> narrow = (Map<?, ?>) page.evaluate(marqueeRead);
                evidence.put("narrow", narrow);
                require("running".equals(narrow.get("state")) && "1776px".equals(narrow.get("distance")),
                    "the running pitch kept the gap from before the breakpoint: " + narrow);
                require(Math.abs(((Number) narrow.get("pitch")).doubleValue() - 148) < 1.5,
                    "the rendered pitch did not follow the gap: " + narrow);
                page.setViewportSize(1280, 900);
                page.waitForTimeout(150);
                frames(page);
                Map<?, ?> back = (Map<?, ?>) page.evaluate(marqueeRead);
                evidence.put("wideAgain", back);
                require("running".equals(back.get("state")) && "1392px".equals(back.get("distance")),
                    "the running pitch did not follow the gap back: " + back);
            });

        // An ancestor transform scales every rectangle; the geometry the
        // module writes is the list's own layout pixels, so a list drawn
        // at 60% runs with its real item size and pitch, and keeps them
        // when the transform settles.
        scenario(browser, engine, "marquee writes layout-pixel geometry under a scaled ancestor", null,
            context -> {
                routeCheckPage(context, "marquee-scaled.html", checkPage(
                    marqueeCss + "#mq-wrap{transform:scale(0.6);transform-origin:0 0}",
                    "<section id=\"mq-wrap\">" + marquee + "</section>", marqueeScripts, null), null);
                marqueeModule.accept(context);
            },
            (page, evidence) -> {
                openCheckPage(page, "marquee-scaled.html");
                page.waitForTimeout(300);
                frames(page);
                Map<?, ?> scaled = (Map<?, ?>) page.evaluate(marqueeRead);
                evidence.put("scaled", scaled);
                require("running".equals(scaled.get("state")), "the scaled list did not run: " + scaled);
                active(true, "the scaled list runs");
                // Undoing the scale leaves floating-point noise far below
                // a device pixel.
                require(Math.abs(Double.parseDouble(String.valueOf(scaled.get("itemSize")).replace("px", "")) - 100) < 0.01 &&
                    Math.abs(Double.parseDouble(String.valueOf(scaled.get("distance")).replace("px", "")) - 1392) < 0.01,
                    "the scaled geometry was written at its rendered size: " + scaled);
                require(Math.abs(((Number) scaled.get("pitch")).doubleValue() - 116) < 1.5,
                    "the items overlap or drift apart under the scale: " + scaled);
                page.evaluate("() => { document.getElementById('mq-wrap').style.transform = 'none'; }");
                frames(page);
                Map<?, ?> settled = (Map<?, ?>) page.evaluate(marqueeRead);
                evidence.put("settled", settled);
                require("running".equals(settled.get("state")) && settled.get("itemSize").equals(scaled.get("itemSize")) &&
                    settled.get("distance").equals(scaled.get("distance")), "the settled transform changed the geometry: " + settled);
            });

        String heroCss = ".paste-ui-hero{position:relative;height:1000px;overflow:hidden}" +
            ".paste-ui-hero-image{position:absolute;inset:0;background:#88c}.paste-ui-hero-content{position:relative;padding:20px}" +
            // The second hero starts in view with its content below the
            // fold, so its content fade writes 0 at bind.
            "#late-h1{height:800px}.late-spacer{height:200px}";
        String heroRead = "() => { const h = document.getElementById('late-h2'), c = document.getElementById('late-c2');" +
            " return {top: Math.round(h.getBoundingClientRect().top), inline: c.style.opacity, opacity: getComputedStyle(c).opacity}; }";

        // An image that lands above a hero after bind, inside a body whose
        // own size is fixed, moves the hero without resizing any watched
        // box: the document's load re-measures, so the hero's content shows
        // once it is scrolled into view.
        List<Route> heldImage = new ArrayList<>();
        scenario(browser, engine, "heroscroll re-measures hero bounds when the document finishes loading", null,
            context -> {
                routeCheckPage(context, "hero-late-load.html", checkPage(
                    "html,body{height:100%}" + heroCss + "#late-img{display:block}#late-tail{height:3000px}",
                    "<section class=\"paste-ui-hero\" id=\"late-h1\"><div class=\"paste-ui-hero-image\"></div><div class=\"paste-ui-hero-content\">one</div></section>" +
                    "<img id=\"late-img\" src=\"/checks/late-hero-800x1200.png\" alt=\"\">" +
                    "<section class=\"paste-ui-hero\" id=\"late-h2\"><div class=\"paste-ui-hero-image\" data-hero-image-fixed></div>" +
                    "<div class=\"late-spacer\"></div><div class=\"paste-ui-hero-content\" id=\"late-c2\">two</div></section><div id=\"late-tail\"></div>",
                    HEROSCROLL_SCRIPTS, null), null);
                // The image is held until the check releases it: the
                // module binds while the document is still loading.
                context.route(url + "checks/late-hero-800x1200.png", heldImage::add);
            },
            (page, evidence) -> {
                heldImage.clear();
                Response navigation = page.navigate(url + "checks/hero-late-load.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.DOMCONTENTLOADED));
                require(navigation != null && navigation.ok(), "regression page hero-late-load.html loads");
                page.waitForFunction("() => document.documentElement.classList.contains('paste-ui-heroscroll-loaded')");
                frames(page);
                require(!"complete".equals(page.evaluate("() => document.readyState")), "the document finished loading before the image was released");
                awaitActive(page, "() => document.getElementById('late-c2').style.opacity === '0'");
                evidence.put("beforeLoad", page.evaluate(heroRead));
                page.waitForCondition(() -> !heldImage.isEmpty());
                heldImage.get(0).fulfill(new Route.FulfillOptions().setContentType("image/png").setBodyBytes(png(800, 1200, 7)));
                page.waitForFunction("() => document.readyState === 'complete'");
                frames(page);
                page.evaluate("() => { const h = document.getElementById('late-h2'); window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 50); }");
                frames(page);
                page.waitForTimeout(100);
                Map<?, ?> after = (Map<?, ?>) page.evaluate(heroRead);
                evidence.put("afterLoadScrolled", after);
                require("1".equals(after.get("opacity")), "the hero kept the content fade of its pre-load position: " + after);
            });

        // Content added above a hero after load grows the body: the body's
        // resize re-measures, so the moved hero's content shows in view.
        scenario(browser, engine, "heroscroll re-measures hero bounds when content above a hero grows", null,
            context -> routeCheckPage(context, "hero-late-growth.html", checkPage(
                heroCss + "#late-tail{height:3000px}",
                "<section class=\"paste-ui-hero\" id=\"late-h1\"><div class=\"paste-ui-hero-image\"></div><div class=\"paste-ui-hero-content\">one</div></section>" +
                "<div id=\"late-slot\"></div>" +
                "<section class=\"paste-ui-hero\" id=\"late-h2\"><div class=\"paste-ui-hero-image\" data-hero-image-fixed></div>" +
                "<div class=\"late-spacer\"></div><div class=\"paste-ui-hero-content\" id=\"late-c2\">two</div></section><div id=\"late-tail\"></div>",
                HEROSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "hero-late-growth.html");
                awaitActive(page, "() => document.getElementById('late-c2').style.opacity === '0'");
                page.evaluate("() => { document.getElementById('late-slot').style.height = '1200px'; }");
                frames(page);
                page.waitForTimeout(100);
                page.evaluate("() => { const h = document.getElementById('late-h2'); window.scrollTo(0, h.getBoundingClientRect().top + scrollY - 50); }");
                frames(page);
                page.waitForTimeout(100);
                Map<?, ?> after = (Map<?, ?>) page.evaluate(heroRead);
                evidence.put("afterGrowthScrolled", after);
                require("1".equals(after.get("opacity")), "the hero kept the content fade of its position before the growth: " + after);
            });
    }

    // progressiveresolution need boxes, vector rungs, lazy nearness under
    // clipping, frames and the scroll fallback, and a detached claim.
    private static void progressiveresolutionBoxAndNearnessRegressions(Browser browser, String engine) {
        String upgradeLadder = "\"upgrades\":[{\"src\":\"/checks/%1$s-200x100.png\",\"width\":200,\"height\":100}," +
            "{\"src\":\"/checks/%1$s-400x200.png\",\"width\":400,\"height\":200}," +
            "{\"src\":\"/checks/%1$s-800x400.png\",\"width\":800,\"height\":400}]";

        // A 100px img with 50px padding and a 25px border paints its image
        // in the 100px content box: at device ratio 2 the 200 rung covers
        // it, where the 250px border box would ask for the 800 rung. The
        // same img under a scale(2) ancestor paints a 200px content box —
        // the insets scale with the rendered box — and takes the 400 rung.
        List<String> paddedRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sizes a padded and bordered img by its content box",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "resolution-padded.html", checkPage(
                "#pb-host,#ps-host{display:block;padding:50px;border:25px solid #888;box-sizing:content-box}" +
                "#ps-wrap{transform:scale(2);transform-origin:0 0}",
                "<img id=\"pb-host\" src=\"/checks/pb-100x50.png\" width=\"100\" height=\"50\" alt=\"padded\"" +
                " data-paste-progressiveresolution data-image-sources=\"#pb-sources\">" +
                "<script type=\"application/json\" id=\"pb-sources\">{\"src\":\"/checks/pb-100x50.png\"," +
                "\"width\":100,\"height\":50," + String.format(upgradeLadder, "pb") + "}</script>" +
                "<div id=\"ps-wrap\"><img id=\"ps-host\" src=\"/checks/ps-100x50.png\" width=\"100\" height=\"50\" alt=\"scaled\"" +
                " data-paste-progressiveresolution data-image-sources=\"#ps-sources\"></div>" +
                "<script type=\"application/json\" id=\"ps-sources\">{\"src\":\"/checks/ps-100x50.png\"," +
                "\"width\":100,\"height\":50," + String.format(upgradeLadder, "ps") + "}</script>",
                RESOLUTION_SCRIPTS, null), paddedRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-padded.html");
                awaitActive(page, "() => document.getElementById('pb-host').currentSrc.endsWith('/checks/pb-200x100.png')");
                awaitActive(page, "() => document.getElementById('ps-host').currentSrc.endsWith('/checks/ps-400x200.png')");
                page.waitForTimeout(400);
                frames(page);
                evidence.put("rect", page.evaluate("() => JSON.stringify(document.getElementById('pb-host').getBoundingClientRect())"));
                evidence.put("currentSrc", page.evaluate("() => document.getElementById('pb-host').currentSrc"));
                evidence.put("requests", List.copyOf(paddedRequests));
                require(paddedRequests.stream().noneMatch(request -> request.contains("pb-400x200") || request.contains("pb-800x400")),
                    "the border box, not the content box, set the need: " + paddedRequests);
                require(paddedRequests.stream().noneMatch(request -> request.contains("ps-800x400")),
                    "the scaled img subtracted unscaled insets: " + paddedRequests);
            });

        // A fixed-attachment cover background is sized against the
        // viewport: a 160x90 host covering a 1280x900 viewport at device
        // ratio 1 needs the 1920 rung, not the base its own box would.
        List<String> fixedRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sharpens a fixed-attachment background for the viewport it covers", null,
            context -> routeCheckPage(context, "resolution-fixed.html", checkPage(
                "#fx-host{width:160px;height:90px;background:url('/checks/fx-160x90.png') center/cover fixed}",
                "<div id=\"fx-host\" data-paste-progressiveresolution data-image-sources=\"#fx-sources\"></div>" +
                "<script type=\"application/json\" id=\"fx-sources\">{\"src\":\"/checks/fx-160x90.png\"," +
                "\"width\":160,\"height\":90,\"upgrades\":[" +
                "{\"src\":\"/checks/fx-640x360.png\",\"width\":640,\"height\":360}," +
                "{\"src\":\"/checks/fx-1920x1080.png\",\"width\":1920,\"height\":1080}]}</script>",
                RESOLUTION_SCRIPTS, null), fixedRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-fixed.html");
                boolean reached;
                try {
                    page.waitForFunction("() => document.getElementById('fx-host').style.backgroundImage.includes('fx-1920x1080')",
                        null, new Page.WaitForFunctionOptions().setTimeout(4000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("viewport", page.evaluate("() => document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight"));
                evidence.put("inline", page.evaluate("() => document.getElementById('fx-host').style.backgroundImage"));
                evidence.put("requests", List.copyOf(fixedRequests));
                active("fixed".equals(page.evaluate("() => getComputedStyle(document.getElementById('fx-host')).backgroundAttachment")),
                    "the host computes a fixed attachment");
                require(reached, "the fixed background was sized against its own box: " + evidence.get("inline"));
            });

        // A viewBox-only SVG reports the engine's own default natural size
        // (300x150 in one engine, 0x0 in another): a vector rung is never
        // held to its declared pixel size.
        List<String> vectorRungRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sharpens with viewBox-only SVG rungs",
            Map.of("deviceScaleFactor", 2),
            context -> {
                routeCheckPage(context, "resolution-svg.html", checkPage(
                    "#pv-host{width:640px;height:360px;background-size:cover;background-image:url('/checks/pv-640.svg')}",
                    "<div id=\"pv-host\" data-paste-progressiveresolution data-image-sources=\"#pv-sources\"></div>" +
                    "<script type=\"application/json\" id=\"pv-sources\">{\"src\":\"/checks/pv-640.svg\"," +
                    "\"width\":640,\"height\":360,\"upgrades\":[{\"src\":\"/checks/pv-1280.svg\",\"width\":1280,\"height\":720}]}</script>",
                    RESOLUTION_SCRIPTS, null), null);
                context.route(requestUrl -> requestUrl.startsWith(url + "checks/pv-") && requestUrl.endsWith(".svg"), route -> {
                    String requestUrl = route.request().url();
                    vectorRungRequests.add(requestUrl.substring(requestUrl.lastIndexOf('/') + 1));
                    boolean up = requestUrl.endsWith("pv-1280.svg");
                    route.fulfill(new Route.FulfillOptions().setContentType("image/svg+xml").setBody(
                        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 " + (up ? "1280 720" : "640 360") + "\">" +
                        "<rect width=\"100%\" height=\"100%\" fill=\"#" + (up ? "2a6f4e" : "6f2a4e") + "\"/></svg>"));
                });
            },
            (page, evidence) -> {
                openCheckPage(page, "resolution-svg.html");
                page.waitForFunction("() => performance.getEntriesByType('resource').some(e => e.name.endsWith('/checks/pv-1280.svg'))",
                    null, new Page.WaitForFunctionOptions().setTimeout(4000));
                active(true, "the 1280 SVG rung was prepared");
                boolean reached;
                try {
                    page.waitForFunction("() => document.getElementById('pv-host').style.backgroundImage.includes('pv-1280.svg')",
                        null, new Page.WaitForFunctionOptions().setTimeout(3000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("decodedSize", page.evaluate("async () => { const i = new Image(); i.src = '/checks/pv-1280.svg';" +
                    " await i.decode(); return i.naturalWidth + 'x' + i.naturalHeight; }"));
                evidence.put("inline", page.evaluate("() => document.getElementById('pv-host').style.backgroundImage"));
                evidence.put("requests", List.copyOf(vectorRungRequests));
                require(reached, "the SVG rung was refused for its decoded size " + evidence.get("decodedSize"));
            });

        // A lazy img inside a frame far down the page: the frame's own
        // viewport would call it near at load, the top-level viewport does
        // not. No upgrade is fetched until the page scrolls the frame near.
        List<String> frameRequests = new ArrayList<>();
        String frameInner = checkPage("",
            "<img id=\"pf-img\" loading=\"lazy\" src=\"/checks/pf-200x100.png\" width=\"200\" height=\"100\" alt=\"framed\"" +
            " data-paste-progressiveresolution data-image-sources=\"#pf-sources\">" +
            "<script type=\"application/json\" id=\"pf-sources\">{\"src\":\"/checks/pf-200x100.png\",\"width\":200,\"height\":100," +
            "\"upgrades\":[{\"src\":\"/checks/pf-400x200.png\",\"width\":400,\"height\":200}]}</script>",
            RESOLUTION_SCRIPTS, null);
        scenario(browser, engine, "progressiveresolution leaves a lazy image in a far-down frame alone until the frame nears",
            Map.of("deviceScaleFactor", 2),
            context -> {
                routeCheckPage(context, "resolution-frame.html", checkPage("",
                    "<div style=\"height:6000px\"></div><iframe id=\"pf-frame\" src=\"/checks/resolution-frame-inner.html\"" +
                    " width=\"600\" height=\"400\"></iframe><div style=\"height:600px\"></div>",
                    RESOLUTION_SCRIPTS, null), frameRequests);
                context.route(url + "checks/resolution-frame-inner.html", route ->
                    route.fulfill(new Route.FulfillOptions().setContentType("text/html; charset=utf-8").setBody(frameInner)));
            },
            (page, evidence) -> {
                openCheckPage(page, "resolution-frame.html");
                String framed = "() => { const d = document.getElementById('pf-frame').contentDocument;" +
                    " const i = d && d.getElementById('pf-img'); return i && d.defaultView.paste ? i : null; }";
                page.waitForFunction("() => (" + framed + ")() !== null");
                page.waitForTimeout(1200);
                List<String> early = new ArrayList<>();
                for (String request : frameRequests) if (request.contains("pf-400x200")) early.add(request);
                evidence.put("upgradesBeforeScroll", early);
                require(early.isEmpty(), "a lazy image in a frame 6000px down fetched its upgrade at load: " + early);
                page.evaluate("() => document.getElementById('pf-frame').scrollIntoView()");
                awaitActive(page, "() => { const i = (" + framed + ")(); return !!i && i.currentSrc.endsWith('/checks/pf-400x200.png'); }",
                    null, new Page.WaitForFunctionOptions().setTimeout(4000));
                evidence.put("requests", List.copyOf(frameRequests));
            });

        // Slides an 800px horizontal carousel clips are not near however
        // close their boxes sit to the viewport (each img sits 300px into
        // its slide, clear of the clip edge): only the visible slide
        // upgrades at load, and a slide upgrades when the carousel
        // scrolls it into view.
        List<String> carouselRequests = new ArrayList<>();
        StringBuilder slides = new StringBuilder();
        for (int slide = 1; slide <= 4; slide += 1) {
            slides.append("<div class=\"cs-slide\"><img id=\"cs-").append(slide).append("\" loading=\"lazy\" src=\"/checks/cs")
                .append(slide).append("-200x100.png\" width=\"200\" height=\"100\" alt=\"slide ").append(slide)
                .append("\" data-paste-progressiveresolution data-image-sources=\"#cs-sources-").append(slide).append("\">")
                .append("<script type=\"application/json\" id=\"cs-sources-").append(slide).append("\">{\"src\":\"/checks/cs")
                .append(slide).append("-200x100.png\",\"width\":200,\"height\":100,\"upgrades\":[{\"src\":\"/checks/cs")
                .append(slide).append("-400x200.png\",\"width\":400,\"height\":200}]}</script></div>");
        }
        scenario(browser, engine, "progressiveresolution keeps clipped carousel slides deferred until the carousel scrolls to them",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "resolution-carousel.html", checkPage(
                "#cs-track{width:800px;overflow-x:auto;white-space:nowrap}" +
                ".cs-slide{display:inline-block;width:800px;height:300px;vertical-align:top}" +
                ".cs-slide img{margin-left:300px}",
                "<div id=\"cs-track\">" + slides + "</div>", RESOLUTION_SCRIPTS, null), carouselRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-carousel.html");
                awaitActive(page, "() => document.getElementById('cs-1').currentSrc.endsWith('/checks/cs1-400x200.png')");
                page.waitForTimeout(1000);
                List<String> early = new ArrayList<>();
                for (String request : carouselRequests) if (request.matches(".*cs[234]-400x200\\.png$")) early.add(request);
                evidence.put("clippedUpgradesAtLoad", early);
                require(early.isEmpty(), "clipped carousel slides fetched their upgrades at load: " + early);
                page.evaluate("() => { document.getElementById('cs-track').scrollLeft = 1600; }");
                awaitActive(page, "() => document.getElementById('cs-3').currentSrc.endsWith('/checks/cs3-400x200.png')",
                    null, new Page.WaitForFunctionOptions().setTimeout(4000));
                page.waitForTimeout(300);
                evidence.put("requests", List.copyOf(carouselRequests));
                require(carouselRequests.stream().noneMatch(request -> request.endsWith("cs2-400x200.png")),
                    "a slide the carousel scrolled past without showing fetched its upgrade: " + carouselRequests);
            });

        // Without an intersection observer the box against the window's
        // viewport decides, on both axes: an img three viewports to the
        // right or to the left of the page stays deferred, and the right
        // one upgrades once the page scrolls it near.
        List<String> sideRequests = new ArrayList<>();
        String sideImg = "<img id=\"sd-%1$s\" loading=\"lazy\" src=\"/checks/sd%1$s-200x100.png\" width=\"200\" height=\"100\"" +
            " alt=\"%1$s\" style=\"position:absolute;top:0;left:%2$s\" data-paste-progressiveresolution data-image-sources=\"#sd-sources-%1$s\">" +
            "<script type=\"application/json\" id=\"sd-sources-%1$s\">{\"src\":\"/checks/sd%1$s-200x100.png\",\"width\":200," +
            "\"height\":100,\"upgrades\":[{\"src\":\"/checks/sd%1$s-400x200.png\",\"width\":400,\"height\":200}]}</script>";
        scenario(browser, engine, "progressiveresolution without an intersection observer defers lazy images off to either side",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "resolution-side.html", checkPage(
                "#sd-row{position:relative;height:200px}",
                "<script>window.IntersectionObserver = undefined;</script><div id=\"sd-row\">" +
                String.format(sideImg, "near", "0px") + String.format(sideImg, "right", "4000px") +
                String.format(sideImg, "left", "-4000px") + "</div>",
                RESOLUTION_SCRIPTS, null), sideRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-side.html");
                require(page.evaluate("() => window.IntersectionObserver === undefined").equals(Boolean.TRUE),
                    "the page runs without an intersection observer");
                awaitActive(page, "() => document.getElementById('sd-near').currentSrc.endsWith('/checks/sdnear-400x200.png')");
                page.waitForTimeout(800);
                List<String> early = new ArrayList<>();
                for (String request : sideRequests) if (request.matches(".*sd(right|left)-400x200\\.png$")) early.add(request);
                evidence.put("sideUpgradesAtLoad", early);
                require(early.isEmpty(), "an img three viewports to the side fetched its upgrade: " + early);
                page.evaluate("() => window.scrollTo(3200, 0)");
                awaitActive(page, "() => document.getElementById('sd-right').currentSrc.endsWith('/checks/sdright-400x200.png')",
                    null, new Page.WaitForFunctionOptions().setTimeout(4000));
                evidence.put("requests", List.copyOf(sideRequests));
                require(sideRequests.stream().noneMatch(request -> request.endsWith("sdleft-400x200.png")),
                    "the img off to the left fetched its upgrade: " + sideRequests);
            });

        // A detached background host computes an empty background-image:
        // no evidence against the claim. Reattached and grown, it keeps
        // upgrading.
        scenario(browser, engine, "progressiveresolution keeps a detached background's claim and upgrades it when reattached",
            Map.of("deviceScaleFactor", 2),
            context -> routeCheckPage(context, "resolution-detached.html", checkPage(
                "#dt-host{width:320px;height:320px;background-size:cover;background-image:url('/checks/dt-320x320.png')}",
                "<div id=\"dt-slot\"><div id=\"dt-host\" data-paste-progressiveresolution data-image-sources=\"#dt-sources\"></div></div>" +
                "<script type=\"application/json\" id=\"dt-sources\">{\"src\":\"/checks/dt-320x320.png\",\"width\":320,\"height\":320," +
                "\"upgrades\":[{\"src\":\"/checks/dt-640x640.png\",\"width\":640,\"height\":640}," +
                "{\"src\":\"/checks/dt-960x960.png\",\"width\":960,\"height\":960}]}</script>",
                RESOLUTION_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "resolution-detached.html");
                awaitActive(page, "() => document.getElementById('dt-host').style.backgroundImage.includes('dt-640x640')");
                page.evaluate("() => { window.__dt = document.getElementById('dt-host'); window.__dt.remove(); }");
                evidence.put("detachedComputed", page.evaluate("() => getComputedStyle(window.__dt).backgroundImage"));
                page.evaluate("() => window.dispatchEvent(new Event('resize'))");
                frames(page);
                page.waitForTimeout(200);
                page.evaluate("() => { document.getElementById('dt-slot').appendChild(window.__dt);" +
                    " window.__dt.style.width = '480px'; window.__dt.style.height = '480px';" +
                    " window.dispatchEvent(new Event('resize')); }");
                boolean reached;
                try {
                    page.waitForFunction("() => window.__dt.style.backgroundImage.includes('dt-960x960')",
                        null, new Page.WaitForFunctionOptions().setTimeout(3000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("inline", page.evaluate("() => window.__dt.style.backgroundImage"));
                require(reached, "the detached host stood down: " + evidence.get("inline"));
            });
    }

    // Fragment focus and hero landing follow the browser's own rules: a
    // click the browser never navigates stops being waited on, an <a
    // name> and a link that targets this window by keyword or name take
    // focus like any other, a scroll-padding page that zeroes the section
    // nav clearance is cleared once, and a hero without an id lands below
    // the nav with a history entry of its own. The clearance rule is read
    // from the mixin source with its auto default resolved to 51px.
    private static void fragmentFocusAndHeroLandingRegressions(Browser browser, String engine) {
        String clearanceRule;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            clearanceRule = rule.find() ? rule.group(1) + "{" + rule.group(2) + "51px" + rule.group(3) + "}" : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }

        // A link inside an editable region is not followed, and a
        // navigation a navigate listener cancels never lands; neither
        // fires hashchange. A later script navigation to the same
        // fragment must not hand focus to its target.
        scenario(browser, engine, "smoothscroll stops waiting on a click the browser never navigates", null,
            context -> routeCheckPage(context, "fragment-unnavigated.html", checkPage(
                "html{scroll-behavior:auto}section{height:1500px}",
                "<nav class=\"paste-ui-section-nav\"><a id=\"nn-go-one\" href=\"#nn-one\">One</a>" +
                " <span contenteditable=\"true\"><a id=\"nn-edit-go\" href=\"#nn-two\">Two</a></span>" +
                " <a id=\"nn-cancel-go\" href=\"#nn-three\">Three</a></nav>" +
                "<section id=\"nn-one\">One<input id=\"nn-field\" aria-label=\"Field\"></section>" +
                "<section id=\"nn-two\">Two</section><section id=\"nn-three\">Three</section>",
                SMOOTHSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-unnavigated.html");
                String later = """
                    hash => new Promise(resolve => {
                      document.getElementById('nn-field').focus();
                      addEventListener('hashchange', () => setTimeout(() => resolve({hash: location.hash,
                        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
                        borrowed: document.querySelectorAll('section[tabindex]').length}), 300), {once: true});
                      location.hash = hash;
                    })
                    """;
                page.click("#nn-edit-go");
                page.waitForTimeout(600);
                evidence.put("afterEditableClick", page.evaluate("() => location.hash"));
                require("".equals(page.evaluate("() => location.hash")), "precondition: a link inside an editable region is not followed");
                Map<?, ?> editable = (Map<?, ?>) page.evaluate(later, "nn-two");
                evidence.put("editableThenScript", editable);
                require("#nn-two".equals(editable.get("hash")) && !"nn-two".equals(editable.get("active")) &&
                    ((Number) editable.get("borrowed")).intValue() == 0,
                    "a later navigation took focus for a click that never navigated: " + editable);

                boolean navigationApi = Boolean.TRUE.equals(page.evaluate("() => 'navigation' in window"));
                evidence.put("navigationApi", navigationApi);
                if (navigationApi) {
                    page.evaluate("() => navigation.addEventListener('navigate', e => { if (e.hashChange) e.preventDefault(); }, {once: true})");
                    page.click("#nn-cancel-go");
                    page.waitForTimeout(600);
                    require("#nn-two".equals(page.evaluate("() => location.hash")), "precondition: the navigate listener cancelled the link");
                    Map<?, ?> cancelled = (Map<?, ?>) page.evaluate(later, "nn-three");
                    evidence.put("cancelledThenScript", cancelled);
                    require("#nn-three".equals(cancelled.get("hash")) && !"nn-three".equals(cancelled.get("active")) &&
                        ((Number) cancelled.get("borrowed")).intValue() == 0,
                        "a later navigation took focus for a cancelled navigation: " + cancelled);
                }

                // The module is live: an ordinary click still focuses.
                page.focus("#nn-field");
                page.click("#nn-go-one");
                awaitActive(page, "() => document.activeElement === document.getElementById('nn-one') && location.hash === '#nn-one'");
            });

        // The browser's fragment lookup and its rules for choosing a
        // browsing context: an <a name> is a target when no id matches, an
        // id outranks a name, and _top, _parent (any case) and the window's
        // own name navigate a top-level document in place.
        scenario(browser, engine, "smoothscroll focuses a named anchor and a link targeting this window by keyword or name", null,
            context -> routeCheckPage(context, "fragment-contexts.html", checkPage(
                "html{scroll-behavior:auto}section{height:1200px}",
                "<nav class=\"paste-ui-section-nav\">" +
                "<a id=\"fc-go-named\" href=\"#fc-named\">Named</a> <a id=\"fc-go-both\" href=\"#fc-both\">Both</a>" +
                " <a id=\"fc-go-top\" href=\"#fc-top\" target=\"_top\">Top</a>" +
                " <a id=\"fc-go-parent\" href=\"#fc-parent\" target=\"_parent\">Parent</a>" +
                " <a id=\"fc-go-upper\" href=\"#fc-upper\" target=\"_TOP\">Upper</a>" +
                " <a id=\"fc-go-self\" href=\"#fc-self\" target=\"fc-main\">Self by name</a></nav>" +
                "<input id=\"fc-field\" aria-label=\"Field\">" +
                "<section>gap</section><a name=\"fc-named\"></a><section>named</section>" +
                "<a name=\"fc-both\"></a><section>name only</section><section id=\"fc-both\">id</section>" +
                "<section id=\"fc-top\">top</section><section id=\"fc-parent\">parent</section>" +
                "<section id=\"fc-upper\">upper</section><section id=\"fc-self\">self</section>",
                SMOOTHSCROLL_SCRIPTS, "window.name = 'fc-main';"), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-contexts.html");
                require(Boolean.TRUE.equals(page.evaluate("() => window.top === window && window.parent === window")),
                    "precondition: the page is a top-level document");
                String[][] links = {
                    {"fc-go-named", "#fc-named", "() => document.activeElement === document.getElementsByName('fc-named')[0]"},
                    {"fc-go-both", "#fc-both", "() => document.activeElement === document.getElementById('fc-both')"},
                    {"fc-go-top", "#fc-top", "() => document.activeElement === document.getElementById('fc-top')"},
                    {"fc-go-parent", "#fc-parent", "() => document.activeElement === document.getElementById('fc-parent')"},
                    {"fc-go-upper", "#fc-upper", "() => document.activeElement === document.getElementById('fc-upper')"},
                    {"fc-go-self", "#fc-self", "() => document.activeElement === document.getElementById('fc-self')"}};
                Map<String, Object> landed = new LinkedHashMap<>();
                List<String> unfocused = new ArrayList<>();
                for (String[] link : links) {
                    page.focus("#fc-field");
                    int pages = page.context().pages().size();
                    page.click("#" + link[0]);
                    page.waitForFunction("hash => location.hash === hash", link[1]);
                    page.waitForTimeout(400);
                    Map<?, ?> state = (Map<?, ?>) page.evaluate("check => ({focused: (0, eval)(check)()," +
                        " active: document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('name') ||" +
                        " document.activeElement.tagName), tabindex: document.activeElement && document.activeElement.getAttribute('tabindex')})", link[2]);
                    landed.put(link[0], state);
                    require(page.context().pages().size() == pages, link[0] + " opened another browsing context");
                    if (!Boolean.TRUE.equals(state.get("focused"))) unfocused.add(link[0]);
                }
                evidence.put("landed", landed);
                require(unfocused.isEmpty(), "links that navigated in place but moved no focus: " + unfocused + " " + landed);
                active(true, "every link navigated this document in place");
            });

        // The browser adds a target's scroll-margin to the scroller's
        // scroll-padding. A page that clears its chrome with
        // scroll-padding-top zeroes the section nav clearance, as the
        // mixin documents, and its targets land once below the chrome.
        scenario(browser, engine, "sectionnav clearance zeroed on a scroll-padding page clears the nav once", null,
            context -> routeCheckPage(context, "fragment-scroll-padding.html", checkPage(
                "html{scroll-behavior:auto;scroll-padding-top:60px}:root{--paste-ui-section-nav-clearance:0px}" + clearanceRule +
                "#sp-nav{position:fixed;top:0;left:0;right:0;height:60px;background:#fff}section{height:1500px}",
                "<nav id=\"sp-nav\" class=\"paste-ui-section-nav\"><a id=\"sp-go-one\" href=\"#sp-one\">One</a>" +
                " <a id=\"sp-go-two\" href=\"#sp-two\">Two</a></nav>" +
                "<section>gap</section><section id=\"sp-one\">One</section><section id=\"sp-two\">Two</section>",
                SMOOTHSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-scroll-padding.html");
                String top = "id => document.getElementById(id).getBoundingClientRect().top";
                require(!clearanceRule.isEmpty(), "the mixin's clearance rule was not found");
                page.click("#sp-go-one");
                awaitActive(page, "() => document.activeElement === document.getElementById('sp-one')");
                double zeroed = ((Number) page.evaluate(top, "sp-one")).doubleValue();
                evidence.put("zeroedTop", zeroed);
                require(Math.abs(zeroed - 60) <= 1, "a zeroed clearance must leave the page's scroll-padding alone: " + zeroed);
                // With the custom property unset the default applies and
                // adds to the scroll-padding: the rule is live.
                page.evaluate("() => document.documentElement.style.setProperty('--paste-ui-section-nav-clearance', 'initial')");
                page.click("#sp-go-two");
                awaitActive(page, "() => document.activeElement === document.getElementById('sp-two')");
                double summed = ((Number) page.evaluate(top, "sp-two")).doubleValue();
                evidence.put("defaultTop", summed);
                active(Math.abs(summed - 111) <= 1, "the default clearance adds to scroll-padding (" + summed + ")");
            });

        // A hero without an id is no fragment target: the stylesheet's
        // clearance still lands it below a fixed nav, and its history
        // entry, written before the scroll and without the fragment of
        // the hero being left, lets each Back return to the hero the
        // visitor left in every engine.
        scenario(browser, engine, "heroscroll hash click to a hero without an id lands below the nav and Back returns to each hero", null,
            context -> routeCheckPage(context, "hero-unnamed.html", checkPage(
                "html{scroll-behavior:auto}" + clearanceRule +
                "#hz-nav{position:fixed;top:0;left:0;right:0;height:51px;background:#fff;z-index:2}#hz-slot{height:51px}" +
                ".paste-ui-hero{position:relative;height:700px;margin:0}.paste-ui-hero-content{padding:40px}#hz-tail{height:3000px}",
                "<div id=\"hz-nav\">nav</div><div id=\"hz-slot\"></div>" +
                "<section id=\"hz-one\" class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one</div></section>" +
                "<section id=\"hz-two\" class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">three</div></section>" +
                "<section id=\"hz-four\" class=\"paste-ui-hero\"><div class=\"paste-ui-hero-content\">four</div></section>" +
                "<div id=\"hz-tail\">tail</div>",
                HEROSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "hero-unnamed.html");
                require(!clearanceRule.isEmpty(), "the mixin's clearance rule was not found");
                String landing = "n => { const hero = document.querySelectorAll('.paste-ui-hero')[n];" +
                    " return {hash: location.hash, top: hero.getBoundingClientRect().top, y: scrollY, length: history.length}; }";
                String settledAt = "n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1";
                int start = ((Number) page.evaluate("() => history.length")).intValue();

                page.click("#hz-one", new Page.ClickOptions().setPosition(20, 100));
                awaitActive(page, "() => location.hash === '#hz-two' && document.getElementById('hz-two').getBoundingClientRect().top <= 52");
                frames(page);
                Map<?, ?> named = (Map<?, ?>) page.evaluate(landing, 1);
                evidence.put("toNamed", named);

                page.click("#hz-two", new Page.ClickOptions().setPosition(20, 100));
                frames(page);
                Map<?, ?> unnamed = (Map<?, ?>) page.evaluate(landing, 2);
                evidence.put("toUnnamed", unnamed);
                require(Math.abs(((Number) unnamed.get("top")).doubleValue() - 51) <= 1,
                    "a hero without an id must land below the fixed nav: " + unnamed);
                require(((Number) unnamed.get("length")).intValue() == start + 2,
                    "a hero without an id must get a history entry of its own: " + unnamed);
                require("".equals(unnamed.get("hash")), "the entry must drop the fragment of the hero it left: " + unnamed);

                page.mouse().click(20, 151);
                page.waitForFunction("() => location.hash === '#hz-four'");
                frames(page);
                evidence.put("toFour", page.evaluate(landing, 3));

                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === ''");
                try {
                    page.waitForFunction(settledAt, 2, new Page.WaitForFunctionOptions().setTimeout(3000));
                } catch (PlaywrightException error) {
                    evidence.put("backWaitError", error.getMessage().split("\n")[0]);
                }
                Map<?, ?> back = (Map<?, ?>) page.evaluate(landing, 2);
                evidence.put("back", back);
                require(Math.abs(((Number) back.get("top")).doubleValue() - 51) <= 1,
                    "Back must return to the hero without an id: " + back);

                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === '#hz-two'");
                try {
                    page.waitForFunction(settledAt, 1, new Page.WaitForFunctionOptions().setTimeout(3000));
                } catch (PlaywrightException error) {
                    evidence.put("back2WaitError", error.getMessage().split("\n")[0]);
                }
                Map<?, ?> back2 = (Map<?, ?>) page.evaluate(landing, 1);
                evidence.put("back2", back2);
                require(Math.abs(((Number) back2.get("top")).doubleValue() - 51) <= 1,
                    "a second Back must return to the hero before it: " + back2);
            });
    }

    // progressiveresolution background attachments: a fixed background
    // sized for the viewport whatever transforms it, a local background
    // over its scrollable content, and the viewport in quirks mode.
    private static void progressiveresolutionAttachmentRegressions(Browser browser, String engine) {
        String ladder = "\"width\":160,\"height\":90,\"upgrades\":[" +
            "{\"src\":\"/checks/%1$s-640x360.png\",\"width\":640,\"height\":360}," +
            "{\"src\":\"/checks/%1$s-1920x1080.png\",\"width\":1920,\"height\":1080}]";
        String host = "<div id=\"%1$s\" style=\"%2$s\" data-paste-progressiveresolution data-image-sources=\"#%1$s-sources\"></div>" +
            "<script type=\"application/json\" id=\"%1$s-sources\">{\"src\":\"/checks/%1$s-160x90.png\"," + ladder + "}</script>";
        String fixedStyle = "width:160px;height:90px;background:url('/checks/%s-160x90.png') center/cover fixed";

        // A fixed background is sized for the 1280x900 viewport — the
        // 1920 rung for a 160x90 base — whatever transforms it: on the
        // host (translateZ(0)), on an ancestor (scale(1)), a will-change
        // naming transform, and a scroll-reveal wrapper whose transform
        // a class later removes, after which the background paints
        // against the viewport and must already be sharp. The fetch may
        // exceed what a transformed host paints; it never falls short.
        List<String> transformedRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sizes a fixed background for the viewport under a transform and after a reveal", null,
            context -> routeCheckPage(context, "resolution-fixed-transform.html", checkPage(
                ".ft-reveal{transform:translateY(2rem)}.ft-reveal.in{transform:none}",
                String.format(host, "ft-ctl", String.format(fixedStyle, "ft-ctl")) +
                String.format(host, "ft-self", String.format(fixedStyle, "ft-self") + ";transform:translateZ(0)") +
                "<div style=\"transform:scale(1)\">" + String.format(host, "ft-anc", String.format(fixedStyle, "ft-anc")) + "</div>" +
                "<div style=\"will-change:transform\">" + String.format(host, "ft-will", String.format(fixedStyle, "ft-will")) + "</div>" +
                "<div id=\"ft-wrap\" class=\"ft-reveal\">" + String.format(host, "ft-rev", String.format(fixedStyle, "ft-rev")) + "</div>",
                RESOLUTION_SCRIPTS, null), transformedRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-fixed-transform.html");
                awaitActive(page, "() => document.getElementById('ft-ctl').style.backgroundImage.includes('ft-ctl-1920x1080')");
                page.waitForTimeout(600);
                frames(page);
                page.evaluate("() => document.getElementById('ft-wrap').classList.add('in')");
                page.waitForTimeout(1200);
                frames(page);
                Map<?, ?> painted = (Map<?, ?>) page.evaluate("() => Object.fromEntries(['ft-self', 'ft-anc', 'ft-will', 'ft-rev']" +
                    ".map(id => [id, document.getElementById(id).style.backgroundImage]))");
                evidence.put("painted", painted);
                evidence.put("requests", List.copyOf(transformedRequests));
                List<String> short_ = new ArrayList<>();
                for (Map.Entry<?, ?> entry : painted.entrySet()) {
                    if (!String.valueOf(entry.getValue()).contains("-1920x1080")) short_.add(entry.getKey() + "=" + entry.getValue());
                }
                require(short_.isEmpty(), "a fixed background was left short of the viewport's need: " + short_);
            });

        // A local background on a 300x200 scroll container over 900px of
        // content covers the whole scrollable area: at least 1600 wide
        // for a 160x90 base, the 1920 rung. The same box with a scroll
        // attachment covers only its own box and takes 640.
        List<String> localRequests = new ArrayList<>();
        String localStyle = "width:300px;height:200px;overflow:auto;background:url('/checks/%s-160x90.png') left top/cover %s";
        scenario(browser, engine, "progressiveresolution sizes a local background by its scrollable content", null,
            context -> routeCheckPage(context, "resolution-local.html", checkPage("",
                String.format(host, "lc-local", String.format(localStyle, "lc-local", "local"))
                    .replace("></div><script", "><div style=\"height:900px\"></div></div><script") +
                String.format(host, "lc-scroll", String.format(localStyle, "lc-scroll", "scroll"))
                    .replace("></div><script", "><div style=\"height:900px\"></div></div><script"),
                RESOLUTION_SCRIPTS, null), localRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-local.html");
                awaitActive(page, "() => document.getElementById('lc-scroll').style.backgroundImage.includes('lc-scroll-640x360')");
                boolean reached;
                try {
                    page.waitForFunction("() => document.getElementById('lc-local').style.backgroundImage.includes('lc-local-1920x1080')",
                        null, new Page.WaitForFunctionOptions().setTimeout(4000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("scrollable", page.evaluate("() => { const h = document.getElementById('lc-local');" +
                    " return h.scrollWidth + 'x' + h.scrollHeight; }"));
                evidence.put("inline", page.evaluate("() => document.getElementById('lc-local').style.backgroundImage"));
                evidence.put("requests", List.copyOf(localRequests));
                require(reached, "the local background was sized against its visible box: " + evidence.get("inline"));
            });

        // In quirks mode neither the root element nor the body reliably
        // reports the viewport: the root element reports its own 5000px
        // box, and under html{overflow:hidden} with a scrolling body one
        // engine's body reports its own box. 1280x900 covered by a 160x90
        // base needs 1600: the 1920 rung, never the 3840 an element box
        // would ask for.
        for (String[] quirk : new String[][] {
                {"", "a tall page"},
                {"html{overflow:hidden}body{margin:50px;overflow:auto}", "a scrolling body"}}) {
            List<String> quirksRequests = new ArrayList<>();
            String quirksPage = "resolution-quirks-" + (quirk[0].isEmpty() ? "tall" : "body") + ".html";
            scenario(browser, engine, "progressiveresolution sizes a fixed background against the viewport in quirks mode with " + quirk[1], null,
                context -> routeCheckPage(context, quirksPage, checkPage(quirk[0],
                    String.format(host, "qk-host", String.format(fixedStyle, "qk-host"))
                        .replace("{\"src\":\"/checks/qk-host-1920x1080.png\",\"width\":1920,\"height\":1080}",
                            "{\"src\":\"/checks/qk-host-1920x1080.png\",\"width\":1920,\"height\":1080}," +
                            "{\"src\":\"/checks/qk-host-3840x2160.png\",\"width\":3840,\"height\":2160}") +
                    "<div style=\"height:5000px\"></div>",
                    RESOLUTION_SCRIPTS, null).replaceFirst("<!DOCTYPE html>", ""), quirksRequests),
                (page, evidence) -> {
                    openCheckPage(page, quirksPage);
                    require("BackCompat".equals(page.evaluate("() => document.compatMode")), "the page renders in quirks mode");
                    awaitActive(page, "() => /qk-host-(1920x1080|3840x2160)/.test(document.getElementById('qk-host').style.backgroundImage)");
                    page.waitForTimeout(400);
                    frames(page);
                    evidence.put("boxes", page.evaluate("() => 'root ' + document.documentElement.clientWidth + 'x' +" +
                        " document.documentElement.clientHeight + ' body ' + document.body.clientWidth + 'x' + document.body.clientHeight +" +
                        " ' inner ' + innerWidth + 'x' + innerHeight"));
                    evidence.put("inline", page.evaluate("() => document.getElementById('qk-host').style.backgroundImage"));
                    evidence.put("requests", List.copyOf(quirksRequests));
                    require(quirksRequests.stream().noneMatch(request -> request.endsWith("qk-host-3840x2160.png")),
                        "quirks mode sized the fixed background against an element box: " + quirksRequests);
                });
        }

        // A local background on an inline box, which overflow does not
        // apply to, reports no scrollable size: it is sized by its own
        // box — a 160x90 base covering about 400x90 takes the 640 rung.
        List<String> inlineRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution sizes a local background on an inline box by its own box", null,
            context -> routeCheckPage(context, "resolution-local-inline.html", checkPage(
                "#li-host{font:80px/1 monospace;overflow:auto;background:url('/checks/li-host-160x90.png') left top/cover local}",
                "<p><span id=\"li-host\" data-paste-progressiveresolution data-image-sources=\"#li-host-sources\">MMMMMMMM</span></p>" +
                "<script type=\"application/json\" id=\"li-host-sources\">{\"src\":\"/checks/li-host-160x90.png\"," +
                String.format(ladder, "li-host") + "}</script>",
                RESOLUTION_SCRIPTS, null), inlineRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-local-inline.html");
                active(((Number) page.evaluate("() => document.getElementById('li-host').getBoundingClientRect().width")).doubleValue() > 160,
                    "the inline host is wider than its base");
                boolean reached;
                try {
                    page.waitForFunction("() => document.getElementById('li-host').style.backgroundImage.includes('li-host-640x360')",
                        null, new Page.WaitForFunctionOptions().setTimeout(3000));
                    reached = true;
                } catch (PlaywrightException timeout) {
                    reached = false;
                }
                evidence.put("box", page.evaluate("() => { const h = document.getElementById('li-host'); const r = h.getBoundingClientRect();" +
                    " return r.width + 'x' + r.height + ' scroll ' + h.scrollWidth + 'x' + h.scrollHeight; }"));
                evidence.put("requests", List.copyOf(inlineRequests));
                require(reached, "the inline local background lost its own box: " + evidence.get("box"));
            });

        // A fixed background that paints as scroll — here under
        // translateZ(0) — covers its own padding box, which can be larger
        // than the 1280x900 viewport. The need is the larger of the two
        // per dimension: a 600x2400 host covers 1280x2400, about 4267 wide
        // for a 160x90 base, so the 5120 rung; a 3000x400 host covers
        // 3000x900, the 3840 rung. The viewport alone would stop both at
        // 1920. A 160x90 host, plain or inside a reveal wrapper whose
        // transform a class later removes, keeps the viewport's 1920.
        List<String> largerRequests = new ArrayList<>();
        String largerLadder = "\"width\":160,\"height\":90,\"upgrades\":[" +
            "{\"src\":\"/checks/%1$s-640x360.png\",\"width\":640,\"height\":360}," +
            "{\"src\":\"/checks/%1$s-1920x1080.png\",\"width\":1920,\"height\":1080}," +
            "{\"src\":\"/checks/%1$s-3840x2160.png\",\"width\":3840,\"height\":2160}," +
            "{\"src\":\"/checks/%1$s-5120x2880.png\",\"width\":5120,\"height\":2880}]";
        String largerHost = "<div id=\"%1$s\" style=\"%2$s\" data-paste-progressiveresolution data-image-sources=\"#%1$s-sources\"></div>" +
            "<script type=\"application/json\" id=\"%1$s-sources\">{\"src\":\"/checks/%1$s-160x90.png\"," + largerLadder + "}</script>";
        String largerStyle = "width:%2$s;height:%3$s;background:url('/checks/%1$s-160x90.png') center/cover fixed%4$s";
        scenario(browser, engine, "progressiveresolution sizes a fixed background painted as scroll for the larger of the viewport and its own box", null,
            context -> routeCheckPage(context, "resolution-fixed-larger.html", checkPage(
                ".fl-reveal{transform:translateY(2rem)}.fl-reveal.in{transform:none}",
                String.format(largerHost, "fl-ctl", String.format(largerStyle, "fl-ctl", "160px", "90px", "")) +
                String.format(largerHost, "fl-tall", String.format(largerStyle, "fl-tall", "600px", "2400px", ";transform:translateZ(0)")) +
                String.format(largerHost, "fl-wide", String.format(largerStyle, "fl-wide", "3000px", "400px", ";transform:translateZ(0)")) +
                "<div id=\"fl-wrap\" class=\"fl-reveal\">" +
                String.format(largerHost, "fl-rev", String.format(largerStyle, "fl-rev", "160px", "90px", "")) + "</div>",
                RESOLUTION_SCRIPTS, null), largerRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-fixed-larger.html");
                evidence.put("viewport", page.evaluate("() => document.documentElement.clientWidth + 'x' + document.documentElement.clientHeight"));
                awaitActive(page, "() => document.getElementById('fl-ctl').style.backgroundImage.includes('fl-ctl-1920x1080')");
                page.waitForTimeout(600);
                frames(page);
                page.evaluate("() => document.getElementById('fl-wrap').classList.add('in')");
                try {
                    page.waitForFunction("() => document.getElementById('fl-tall').style.backgroundImage.includes('-5120x2880') &&" +
                        " document.getElementById('fl-wide').style.backgroundImage.includes('-3840x2160') &&" +
                        " document.getElementById('fl-rev').style.backgroundImage.includes('-1920x1080')",
                        null, new Page.WaitForFunctionOptions().setTimeout(6000));
                } catch (PlaywrightException timeout) {
                    // The assertions below name what fell short.
                }
                frames(page);
                Map<?, ?> painted = (Map<?, ?>) page.evaluate("() => Object.fromEntries(['fl-ctl', 'fl-tall', 'fl-wide', 'fl-rev']" +
                    ".map(id => [id, document.getElementById(id).style.backgroundImage]))");
                evidence.put("painted", painted);
                evidence.put("requests", List.copyOf(largerRequests));
                Map<String, String> expected = Map.of("fl-ctl", "-1920x1080", "fl-tall", "-5120x2880",
                    "fl-wide", "-3840x2160", "fl-rev", "-1920x1080");
                List<String> wrong = new ArrayList<>();
                for (Map.Entry<String, String> entry : expected.entrySet()) {
                    if (!String.valueOf(painted.get(entry.getKey())).contains(entry.getValue())) {
                        wrong.add(entry.getKey() + "=" + painted.get(entry.getKey()));
                    }
                }
                require(wrong.isEmpty(), "a fixed background was not sized for the larger of the viewport and its own box: " + wrong);
            });

        // A host requestAnimationFrame that throws on its first call, made
        // while scrollscrub binds: the page still progresses — the next
        // scroll publishes the progress. animation_frame's own fallback
        // carries this; scrollscrub's guard is only defence in depth.
        scenario(browser, engine, "scrollscrub still publishes progress when the host throws on its first animation frame", null,
            context -> routeCheckPage(context, "scrub-refused-frame.html", checkPage(
                "body{min-height:400vh}#rf-scope{margin-top:150vh;height:50vh}",
                "<script>(function () { var raf = window.requestAnimationFrame, refusals = 1;" +
                " window.requestAnimationFrame = function (callback) { if (refusals > 0) { refusals -= 1;" +
                " window.__rfRefused = true; throw new Error('frame refused'); } return raf.call(window, callback); }; }());</script>" +
                "<section id=\"rf-scope\" data-paste-scrollscrub data-scrub-start=\"top bottom\" data-scrub-end=\"bottom top\"></section>",
                SEQUENCE_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "scrub-refused-frame.html");
                active(Boolean.TRUE.equals(page.evaluate("() => window.__rfRefused === true")),
                    "the host refused the first frame request");
                page.evaluate("() => window.scrollTo(0, document.getElementById('rf-scope').offsetTop - innerHeight / 2)");
                boolean published;
                try {
                    page.waitForFunction("() => document.getElementById('rf-scope').style.getPropertyValue('--paste-scrub-progress') !== ''",
                        null, new Page.WaitForFunctionOptions().setTimeout(3000));
                    published = true;
                } catch (PlaywrightException timeout) {
                    published = false;
                }
                evidence.put("progress", page.evaluate("() => document.getElementById('rf-scope').style.getPropertyValue('--paste-scrub-progress')"));
                require(published, "scrollscrub published no progress after the host threw on its first animation frame");
            });

        // The same throwing first frame on a page with progressiveresolution
        // alone: the page still progresses — after a resize the 1920 rung
        // a 160x90 base needs over 1280x720 is fetched and painted.
        String refusingFrame = "<script>(function () { var raf = window.requestAnimationFrame, refusals = 1;" +
            " window.requestAnimationFrame = function (callback) { if (refusals > 0) { refusals -= 1;" +
            " window.__rfRefused = true; throw new Error('frame refused'); } return raf.call(window, callback); }; }());</script>";
        List<String> refusedResolutionRequests = new ArrayList<>();
        scenario(browser, engine, "progressiveresolution still upgrades when the host throws on its first animation frame", null,
            context -> routeCheckPage(context, "resolution-refused-frame.html", checkPage(
                "#rr-host{width:1280px;height:720px;background:url('/checks/rr-host-160x90.png') center/cover}",
                refusingFrame + String.format(host, "rr-host", ""),
                RESOLUTION_SCRIPTS, null), refusedResolutionRequests),
            (page, evidence) -> {
                openCheckPage(page, "resolution-refused-frame.html");
                active(Boolean.TRUE.equals(page.evaluate("() => window.__rfRefused === true")),
                    "the host refused the first frame request");
                page.evaluate("() => window.dispatchEvent(new Event('resize'))");
                boolean upgraded;
                try {
                    page.waitForFunction("() => document.getElementById('rr-host').style.backgroundImage.includes('rr-host-1920x1080')",
                        null, new Page.WaitForFunctionOptions().setTimeout(4000));
                    upgraded = true;
                } catch (PlaywrightException timeout) {
                    upgraded = false;
                }
                evidence.put("inline", page.evaluate("() => document.getElementById('rr-host').style.backgroundImage"));
                evidence.put("requests", List.copyOf(refusedResolutionRequests));
                require(upgraded, "progressiveresolution never upgraded after the host threw on its first animation frame");
            });

        // And with imagesequence alone (no scrollscrub, whose bind would
        // take the throwing first frame): the page still progresses — a
        // scroll paints a later frame.
        scenario(browser, engine, "imagesequence still scrubs when the host throws on its first animation frame", null,
            context -> routeCheckPage(context, "sequence-refused-frame.html", checkPage(
                ".rs-pad{height:100vh}#rs-band{height:300vh;position:relative}" +
                "#rs-scene{position:sticky;top:0;height:100vh}" +
                "#rs-host{display:block;width:640px;height:360px;background-size:cover;" +
                "background-image:url('/checks/rs-frame-0-320x180.png')}",
                refusingFrame +
                "<div class=\"rs-pad\"></div><section id=\"rs-band\"><div id=\"rs-scene\" data-paste-scrollscrub" +
                " data-scrub-subject=\"#rs-band\" data-scrub-start=\"top top\" data-scrub-end=\"bottom bottom\">" +
                "<i id=\"rs-host\" data-paste-imagesequence=\"#rs-frames\" data-sequence-from=\"0\" data-sequence-to=\"7\"></i>" +
                "<script type=\"application/json\" id=\"rs-frames\">" + catalogJson("rs", 8, 320, 180, 0, 0) + "</script>" +
                "</div></section><div class=\"rs-pad\"></div>",
                new String[]{"/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/event.js",
                    "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/scrollrange.js",
                    "/js/paste/ui/utilities/imageresolution.js", "/js/paste/ui/utilities/mediaquery.js",
                    "/js/paste/ui/imagesequence.js"}, null), null),
            (page, evidence) -> {
                openCheckPage(page, "sequence-refused-frame.html");
                active(Boolean.TRUE.equals(page.evaluate("() => window.__rfRefused === true")),
                    "the host refused the first frame request");
                String painted = "() => { const v = getComputedStyle(document.getElementById('rs-host')).backgroundImage;" +
                    " const m = /rs-frame-(\\d+)-/.exec(v); return m ? Number(m[1]) : -1; }";
                page.evaluate("() => { const b = document.getElementById('rs-band').getBoundingClientRect();" +
                    " window.scrollTo(0, b.top + scrollY + (b.height - innerHeight) * 0.6); }");
                boolean scrubbed;
                try {
                    page.waitForFunction("() => (" + painted + ")() > 0", null, new Page.WaitForFunctionOptions().setTimeout(4000));
                    scrubbed = true;
                } catch (PlaywrightException timeout) {
                    scrubbed = false;
                }
                evidence.put("painted", page.evaluate(painted));
                require(scrubbed, "imagesequence never scrubbed after the host threw on its first animation frame");
            });
    }

    // A hero without an id gets a history entry whose address names no
    // element it does not show, keeps another script's state tokens and
    // never reads as the bare first entry; the clearance marks only the
    // hero a hash click scrolled to, so snapping heroes stay aligned; and
    // a quirks-mode name differing in case takes focus exactly where the
    // browser made it the target.
    private static void heroEntryAndQuirksNameRegressions(Browser browser, String engine) {
        String clearanceRule;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            clearanceRule = rule.find() ? rule.group(1) + "{" + rule.group(2) + "51px" + rule.group(3) + "}" : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
        String heroChain = "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one <span id=\"hy-inner\">inner</span></div></section>" +
            "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>" +
            "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">three</div></section>" +
            "<section class=\"paste-ui-hero\"><div class=\"paste-ui-hero-content\">four</div></section>";
        String heroStyle = "html{scroll-behavior:auto}" + clearanceRule +
            "#hy-nav{position:fixed;top:0;left:0;right:0;height:51px;background:#fff;z-index:2}#hy-slot{height:51px}" +
            ".paste-ui-hero{position:relative;height:700px;margin:0}.paste-ui-hero-content{padding:40px}#hy-contact{height:400px}#hy-tail{height:3000px}";
        String heroTop = "n => Math.round(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top)";

        // An address fragment that names an element — another section,
        // a span inside the hero being left — gives way to the empty
        // fragment: the address names nothing the entry does not show,
        // and no engine scrolls to that element on Back or Forward.
        scenario(browser, engine, "heroscroll entry for a hero without an id names no element it does not show", null,
            context -> routeCheckPage(context, "hero-entry.html", checkPage(heroStyle,
                "<div id=\"hy-nav\">nav</div><div id=\"hy-slot\"></div>" + heroChain +
                "<div id=\"hy-contact\">contact</div><div id=\"hy-tail\">tail</div>",
                HEROSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                for (String fragment : List.of("hy-contact", "hy-inner")) {
                    // A fresh document each time: a fragment-only change of
                    // address would be a same-document navigation.
                    page.navigate("about:blank");
                    Response navigation = page.navigate(url + "checks/hero-entry.html#" + fragment,
                        new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                    require(navigation != null && navigation.ok(), "regression page hero-entry.html loads");
                    page.evaluate("() => scrollTo(0, 0)");
                    page.waitForFunction("() => scrollY === 0");
                    page.mouse().click(20, 151);
                    frames(page);
                    page.mouse().click(20, 151);
                    frames(page);
                    Map<?, ?> after = (Map<?, ?>) page.evaluate("() => ({href: location.href, hash: location.hash, y: scrollY})");
                    evidence.put(fragment + "-afterClicks", after);
                    active(Math.abs(((Number) page.evaluate(heroTop, 2)).doubleValue() - 51) <= 1, "two hash clicks reached the third hero");
                    require(String.valueOf(after.get("href")).endsWith("hero-entry.html#") && "".equals(after.get("hash")),
                        "the entry still names #" + fragment + ", which it does not show: " + after);
                    List<Object> steps = new ArrayList<>();
                    String[][] traversal = {{"back", "1"}, {"back", "0"}, {"forward", "1"}, {"forward", "2"}};
                    for (String[] step : traversal) {
                        page.evaluate(step[0].equals("back") ? "() => history.back()" : "() => history.forward()");
                        int hero = Integer.parseInt(step[1]);
                        // Each hero shows at the clearance: the first in
                        // flow below the slot, the others by the click.
                        String expected = "n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1";
                        try {
                            page.waitForFunction(expected, hero, new Page.WaitForFunctionOptions().setTimeout(3000));
                        } catch (PlaywrightException error) {
                            evidence.put(fragment + "-steps", steps);
                            require(false, step[0] + " after #" + fragment + " did not return to hero " + (hero + 1) + ": y=" +
                                page.evaluate("() => scrollY") + " " + page.evaluate("() => location.href"));
                        }
                        steps.add(page.evaluate("() => ({hash: location.hash, y: scrollY})"));
                    }
                    evidence.put(fragment + "-steps", steps);
                }
            });

        // multistate keeps tabs in the fragment and reads an address with no
        // '#' at all as the bare first entry, where it restores the authored
        // defaults. The hero's entry keeps a token fragment as it is and an
        // emptied fragment's '#', so traversal keeps the selection.
        String[] heroMultistateScripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
            "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
            "/js/paste/polyfills/getcomputedstyle.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/mediaquery.js",
            "/js/paste/ui/heroscroll.js", "/js/paste/ui/multistate.js"};
        scenario(browser, engine, "heroscroll entry for a hero without an id keeps multistate's selection across Back and Forward", null,
            context -> routeCheckPage(context, "hero-multistate.html", checkPage(heroStyle +
                "[data-multistate-value]{display:none}[data-multistate-state]{display:inline}",
                "<div id=\"hy-nav\">" +
                "<input id=\"hm-a\" type=\"radio\" data-multistate-key=\"area1\" value=\"a\" checked><label for=\"hm-a\">A</label>" +
                "<input id=\"hm-b\" type=\"radio\" data-multistate-key=\"area1\" value=\"b\"><label for=\"hm-b\">B</label>" +
                "<input id=\"hm-c\" type=\"radio\" data-multistate-key=\"area1\" value=\"c\"><label for=\"hm-c\">C</label>" +
                "<span data-multistate-key=\"area1\" data-multistate-value=\"a\">a</span>" +
                "<span data-multistate-key=\"area1\" data-multistate-value=\"b\">b</span>" +
                "<span data-multistate-key=\"area1\" data-multistate-value=\"c\">c</span>" +
                " <a id=\"hm-go\" href=\"#hm-one\">one</a></div><div id=\"hy-slot\"></div>" +
                heroChain.replaceFirst("<section class=\"paste-ui-hero\"", "<section id=\"hm-one\" class=\"paste-ui-hero\"") +
                "<div id=\"hy-tail\">tail</div>",
                heroMultistateScripts, null), null),
            (page, evidence) -> {
                String shown = "() => document.querySelector('[data-multistate-key=area1][data-multistate-state]')?.getAttribute('data-multistate-value') ?? null";
                String settled = "v => document.querySelector('[data-multistate-key=area1][data-multistate-state]')?.getAttribute('data-multistate-value') === v";
                openCheckPage(page, "hero-multistate.html");
                page.click("#hm-b");
                awaitActive(page, "() => decodeURIComponent(location.hash) === '#area1:b'");
                page.click("#hm-go");
                page.waitForFunction("() => location.hash === '#hm-one'");
                frames(page);
                page.mouse().click(20, 300);
                frames(page);
                Map<?, ?> entry = (Map<?, ?>) page.evaluate("() => ({href: location.href, top: document.querySelectorAll('.paste-ui-hero')[1].getBoundingClientRect().top})");
                evidence.put("heroEntry", entry);
                require(String.valueOf(entry.get("href")).endsWith("hero-multistate.html#"),
                    "an emptied fragment must keep its '#': " + entry);
                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === '#hm-one'");
                frames(page);
                evidence.put("back", page.evaluate(shown));
                require("b".equals(page.evaluate(shown)), "Back to the link's entry must keep the selection: " + page.evaluate(shown));
                page.evaluate("() => history.forward()");
                page.waitForFunction("() => location.hash === '' && location.href.endsWith('#')");
                frames(page);
                evidence.put("forward", page.evaluate(shown));
                require("b".equals(page.evaluate(shown)), "Forward to the hero's entry reset the selection to " + page.evaluate(shown));
                page.click("#hm-c");
                page.waitForFunction("() => decodeURIComponent(location.hash) === '#area1:c'");
                page.evaluate("() => history.back()");
                page.waitForFunction("() => location.hash === '' && location.href.endsWith('#')");
                frames(page);
                evidence.put("backAfterChange", page.evaluate(shown));
                require("c".equals(page.evaluate(shown)), "Back to the hero's entry reset a later selection to " + page.evaluate(shown));

                // A token fragment is kept on the hero's entry as it is.
                openCheckPage(page, "hero-multistate.html");
                page.click("#hm-b");
                page.waitForFunction("() => decodeURIComponent(location.hash) === '#area1:b'");
                page.mouse().click(20, 300);
                frames(page);
                Map<?, ?> kept = (Map<?, ?>) page.evaluate("() => ({hash: decodeURIComponent(location.hash), length: history.length})");
                evidence.put("tokenEntry", kept);
                require("#area1:b".equals(kept.get("hash")), "a multistate token was rewritten on the hero's entry: " + kept);
                page.evaluate("() => history.back()");
                page.waitForFunction(settled, "b");
                page.evaluate("() => history.forward()");
                page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1", 1);
                require("b".equals(page.evaluate(shown)), "traversal over a token entry changed the selection: " + page.evaluate(shown));
            });

        // scroll-margin offsets a scroll-snap area. Only the hero a hash
        // click scrolled to carries the clearance; the heroes after it
        // keep snapping at the top.
        scenario(browser, engine, "sectionnav clearance leaves snapping heroes after a hash-click hero aligned", null,
            context -> routeCheckPage(context, "hero-snap.html", checkPage(
                "html{scroll-snap-type:y mandatory;scroll-behavior:auto}" + clearanceRule +
                ".paste-ui-hero{height:900px;margin:0;scroll-snap-align:start;box-sizing:border-box}",
                "<section class=\"paste-ui-hero\" data-hero-hashclick>one</section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick>two</section>" +
                "<section class=\"paste-ui-hero\">three</section><section class=\"paste-ui-hero\">four</section>",
                HEROSCROLL_SCRIPTS, null), null),
            (page, evidence) -> {
                openCheckPage(page, "hero-snap.html");
                require(!clearanceRule.isEmpty(), "the mixin's clearance rule was not found");
                // Short of the second hero: the nearest snap position is its own.
                page.evaluate("() => scrollTo(0, 800)");
                frames(page);
                page.waitForTimeout(1000);
                double snapped = ((Number) page.evaluate(heroTop, 1)).doubleValue();
                evidence.put("secondHeroSnapped", snapped);
                require(Math.abs(snapped) <= 1, "a hero after a hash-click hero snapped " + snapped + "px low");
                page.evaluate("() => scrollTo(0, 0)");
                frames(page);
                page.waitForTimeout(1000);
                page.mouse().click(20, 300);
                frames(page);
                page.waitForTimeout(1000);
                double clicked = ((Number) page.evaluate(heroTop, 1)).doubleValue();
                evidence.put("secondHeroAfterHashClick", clicked);
                active(Math.abs(clicked - 51) <= 1, "the hash click's destination lands below the clearance (" + clicked + ")");
                page.evaluate("() => scrollTo(0, 1700)");
                frames(page);
                page.waitForTimeout(1000);
                double third = ((Number) page.evaluate(heroTop, 2)).doubleValue();
                evidence.put("thirdHeroSnapped", third);
                require(Math.abs(third) <= 1, "a hero the click did not reach snapped " + third + "px low");
            });

        // In a quirks-mode document Chromium and WebKit also take an
        // <a name> that matches without regard to case, Firefox does not.
        // Focus follows exactly the element the browser made its target.
        StringBuilder quirks = new StringBuilder("<html lang=\"en\"><head><meta charset=\"utf-8\"><style>body{margin:0}.gap{height:2000px}</style></head><body>")
            .append("<nav class=\"paste-ui-section-nav\"><a id=\"fq-go-case\" href=\"#fq-sec\">case</a> <a id=\"fq-go-exact\" href=\"#FQ-Exact\">exact</a></nav>")
            .append("<input id=\"fq-field\" aria-label=\"Field\"><div class=\"gap\">gap</div><a name=\"FQ-Sec\">sec</a><div class=\"gap\">after</div>")
            .append("<a name=\"FQ-Exact\">exact</a><div class=\"gap\">after</div>");
        for (String src : SMOOTHSCROLL_SCRIPTS) {
            quirks.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        quirks.append("</body></html>");
        scenario(browser, engine, "smoothscroll in a quirks-mode document focuses a case-folded name only where the browser targets it", null,
            context -> routeCheckPage(context, "fragment-quirks.html", quirks.toString(), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-quirks.html");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                String state = "() => { const a = document.getElementsByName('FQ-Sec')[0]; return {hash: location.hash," +
                    " targeted: a.matches(':target'), focused: document.activeElement === a," +
                    " active: document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('name') || document.activeElement.tagName)}; }";
                page.focus("#fq-field");
                page.click("#fq-go-case");
                page.waitForFunction("() => location.hash === '#fq-sec'");
                page.waitForTimeout(500);
                Map<?, ?> folded = (Map<?, ?>) page.evaluate(state);
                evidence.put("caseFolded", folded);
                require(Boolean.TRUE.equals(folded.get("targeted")) == Boolean.TRUE.equals(folded.get("focused")),
                    "focus must follow the browser's own target for a case-folded name: " + folded);
                page.focus("#fq-field");
                page.click("#fq-go-exact");
                awaitActive(page, "() => document.activeElement === document.getElementsByName('FQ-Exact')[0]");
            });

        // form: a native submit encodes in the form's encoding — the first
        // accept-charset label the browser recognises, else the
        // document's, with UTF-16 sent as UTF-8 — while the background
        // body is always UTF-8. A form whose submit would go out in
        // anything else must reach the server as the browser would send
        // it: the same bytes as an unenhanced twin. A UTF-8 form on the
        // same page is still taken over, and so is a UTF-16 one, whose
        // background bytes equal its native twin's.
        String[] formCharsetScripts = {"/js/paste/paste.js", "/js/paste/util.js", "/js/paste/guid.js",
            "/js/paste/event.js", "/js/paste/io.js", "/js/paste/ui/form.js"};
        for (String[] variant : List.of(
                new String[] {"urlencoded post, accept-charset ISO-8859-1", "post", "application/x-www-form-urlencoded", "ISO-8859-1", "utf-8"},
                new String[] {"get, accept-charset Shift_JIS", "get", "application/x-www-form-urlencoded", "Shift_JIS", "utf-8"},
                new String[] {"multipart post, accept-charset windows-1252", "post", "multipart/form-data", "windows-1252", "utf-8"},
                new String[] {"urlencoded post, windows-1252 document", "post", "application/x-www-form-urlencoded", null, "windows-1252"},
                new String[] {"get, Shift_JIS document", "get", "application/x-www-form-urlencoded", null, "Shift_JIS"},
                // Some engines split labels on a comma as well.
                new String[] {"urlencoded post, accept-charset ISO-8859-1,utf-8", "post", "application/x-www-form-urlencoded", "ISO-8859-1,utf-8", "utf-8"},
                new String[] {"urlencoded post, accept-charset utf-8, ISO-8859-1", "post", "application/x-www-form-urlencoded", "utf-8, ISO-8859-1", "utf-8"},
                // A replacement-encoding label first: some engines send
                // UTF-8, others the label after it.
                new String[] {"urlencoded post, accept-charset iso-2022-kr windows-1252", "post", "application/x-www-form-urlencoded", "iso-2022-kr windows-1252", "utf-8"},
                // UTF-16 goes out as UTF-8 natively: these stay in the
                // background.
                new String[] {"get, accept-charset utf-16", "get", "application/x-www-form-urlencoded", "utf-16", "utf-8", "background"},
                new String[] {"urlencoded post, accept-charset utf-16be", "post", "application/x-www-form-urlencoded", "utf-16be", "utf-8", "background"},
                new String[] {"multipart post, accept-charset utf-16", "post", "multipart/form-data", "utf-16", "utf-8", "background"},
                new String[] {"urlencoded post, accept-charset utf-16 in a windows-1252 document", "post", "application/x-www-form-urlencoded", "utf-16", "windows-1252", "background"},
                new String[] {"get, UTF-16LE document", "get", "application/x-www-form-urlencoded", null, "UTF-16LE", "background"},
                new String[] {"urlencoded post, UTF-16LE document", "post", "application/x-www-form-urlencoded", null, "UTF-16LE", "background"})) {
            String label = variant[0];
            String method = variant[1];
            String enctype = variant[2];
            String acceptCharset = variant[3];
            String documentCharset = variant[4];
            boolean background = variant.length > 5;
            List<Map<String, String>> charsetRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            scenario(browser, engine, (background
                    ? "form keeps a submit the browser sends as UTF-8 in the background ("
                    : "form leaves a submit whose encoding is not UTF-8 to the browser (") + label + ")", null,
                context -> {
                    String fields = "<input name=\"n\"><textarea name=\"t\"></textarea><button name=\"go\" value=\"1\">Send</button>";
                    String declared = acceptCharset == null ? "" : " accept-charset=\"" + acceptCharset + "\"";
                    String formAttributes = " action=\"/form-charset\" method=\"" + method + "\" enctype=\"" + enctype + "\"";
                    String html = checkPage("",
                        "<div id=\"cs-control\" data-paste-io-reply-fragment-target><form data-paste-form" + formAttributes +
                        " accept-charset=\"utf-8\">" + fields + "</form></div>" +
                        "<div id=\"cs-reply\" data-paste-io-reply-fragment-target><form id=\"cs-enhanced\" data-paste-form" +
                        formAttributes + declared + ">" + fields + "</form></div>" +
                        "<div id=\"cs-plain\"><form id=\"cs-native\"" + formAttributes + declared + ">" + fields + "</form></div>",
                        formCharsetScripts,
                        // Values set from script keep the page source ASCII.
                        "document.querySelectorAll('input[name=n]').forEach(i => { i.value = 'caf\\u00e9 \\u20ac5 \\u65e5\\u672c'; });" +
                        " document.querySelectorAll('textarea').forEach(t => { t.value = 'a\\u00df\\nb'; });")
                        .replace("<meta charset=\"utf-8\">", "<meta charset=\"" + documentCharset + "\">");
                    String pageUrl = url + "checks/form-charset.html";
                    // A UTF-16 document is little-endian behind its byte
                    // order mark.
                    byte[] pageBytes;
                    if (documentCharset.startsWith("UTF-16")) {
                        byte[] text = html.getBytes(java.nio.charset.StandardCharsets.UTF_16LE);
                        pageBytes = new byte[text.length + 2];
                        pageBytes[0] = (byte) 0xFF;
                        pageBytes[1] = (byte) 0xFE;
                        System.arraycopy(text, 0, pageBytes, 2, text.length);
                    } else {
                        pageBytes = html.getBytes(java.nio.charset.StandardCharsets.US_ASCII);
                    }
                    context.route(requestUrl -> requestUrl.startsWith(url + "checks/"), route -> {
                        if (route.request().url().equals(pageUrl)) {
                            route.fulfill(new Route.FulfillOptions()
                                .setContentType("text/html; charset=" + documentCharset)
                                .setBodyBytes(pageBytes));
                        } else {
                            route.fulfill(new Route.FulfillOptions().setStatus(404));
                        }
                    });
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-charset"), route -> {
                        Request request = route.request();
                        String contentType = request.headerValue("content-type");
                        byte[] body = request.postDataBuffer();
                        String raw = body == null ? "" : new String(body, java.nio.charset.StandardCharsets.ISO_8859_1);
                        Matcher boundary = contentType == null ? null : Pattern.compile("boundary=(.+)$").matcher(contentType);
                        if (boundary != null && boundary.find()) {
                            raw = raw.replace(boundary.group(1), "BOUNDARY");
                        }
                        Map<String, String> seen = new LinkedHashMap<>();
                        seen.put("type", request.resourceType());
                        seen.put("method", request.method());
                        seen.put("query", String.valueOf(URI.create(request.url()).getRawQuery()));
                        seen.put("body", raw);
                        charsetRequests.add(seen);
                        route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                            .setBody("<p id=\"cs-answer\">answered</p>"));
                    });
                },
                (page, evidence) -> {
                    openCheckPage(page, "form-charset.html");
                    verifyPageDependencies(page);
                    require(documentCharset.equalsIgnoreCase(String.valueOf(page.evaluate("() => document.characterSet"))),
                        "precondition: the document is " + documentCharset);
                    page.click("#cs-control button");
                    awaitActive(page, "() => document.querySelector('#cs-control #cs-answer') !== null");
                    active(charsetRequests.size() == 1 && !"document".equals(charsetRequests.get(0).get("type")),
                        "the UTF-8 form was sent in the background: " + charsetRequests);
                    page.click("#cs-native button");
                    page.waitForCondition(() -> charsetRequests.size() == 2);
                    page.waitForSelector("body > #cs-answer");
                    openCheckPage(page, "form-charset.html");
                    page.click("#cs-enhanced button");
                    page.waitForCondition(() -> charsetRequests.size() == 3);
                    page.waitForTimeout(300);
                    Map<String, String> nativeRequest = charsetRequests.get(1);
                    Map<String, String> enhancedRequest = charsetRequests.get(2);
                    evidence.put("requests", List.copyOf(charsetRequests));
                    require("document".equals(nativeRequest.get("type")), "precondition: the twin submitted natively: " + nativeRequest);
                    if (background) {
                        Map<String, String> sent = new LinkedHashMap<>(enhancedRequest);
                        sent.put("type", "document");
                        require(!"document".equals(enhancedRequest.get("type"))
                                && page.locator("#cs-reply #cs-answer").count() == 1,
                            "a submit the browser sends as UTF-8 was declined: " + enhancedRequest);
                        require(nativeRequest.equals(sent),
                            "the background submit sent other bytes than the browser: " + enhancedRequest + " vs native " + nativeRequest);
                        return;
                    }
                    require("document".equals(enhancedRequest.get("type")),
                        "the form was taken over instead of submitting natively: " + enhancedRequest);
                    require(nativeRequest.equals(enhancedRequest),
                        "the form sent other bytes than the browser: " + enhancedRequest + " vs native " + nativeRequest);
                });
        }

        // form: one IO reply fragment target answers one submission at a
        // time. While a form's request is pending, a second form in the
        // same target — or in a target inside it — sends nothing and the
        // target stays busy; the owner's answer is the one that lands, and
        // the target takes the next submit once it has.
        for (boolean nested : List.of(false, true)) {
            List<String> ownerRequests = new java.util.concurrent.CopyOnWriteArrayList<>();
            List<Route> heldOwners = new java.util.concurrent.CopyOnWriteArrayList<>();
            String second = "<form id=\"ow-second\" data-paste-form action=\"/form-own-second\" method=\"post\">" +
                "<input name=\"x\" value=\"b\"><button>Second</button></form>";
            scenario(browser, engine, "form gives a shared reply target one owner at a time (" + (nested ? "nested target" : "same target") + ")", null,
                context -> {
                    routeCheckPage(context, "form-owner.html", checkPage("",
                        "<div id=\"ow-reply\" data-paste-io-reply-fragment-target>" +
                        "<form id=\"ow-first\" data-paste-form action=\"/form-own-first\" method=\"post\">" +
                        "<input name=\"x\" value=\"a\"><button>First</button></form>" +
                        (nested ? "<div id=\"ow-inner\" data-paste-io-reply-fragment-target>" + second + "</div>" : second) +
                        "</div>",
                        formCharsetScripts, null), null);
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-own-first"), route -> {
                        ownerRequests.add("first " + route.request().resourceType());
                        heldOwners.add(route);
                    });
                    context.route(requestUrl -> URI.create(requestUrl).getPath().equals("/form-own-second"), route -> {
                        ownerRequests.add("second " + route.request().resourceType());
                        route.fulfill(new Route.FulfillOptions().setContentType("text/html")
                            .setBody("<p id=\"ow-second-answer\">second</p>"));
                    });
                },
                (page, evidence) -> {
                    String formPage = url + "checks/form-owner.html";
                    openCheckPage(page, "form-owner.html");
                    verifyPageDependencies(page);
                    page.click("#ow-first button");
                    awaitActive(page, "() => document.getElementById('ow-reply').getAttribute('aria-busy') === 'true'");
                    page.waitForCondition(() -> heldOwners.size() == 1);
                    page.click("#ow-second button", new Page.ClickOptions().setNoWaitAfter(true));
                    page.waitForTimeout(600);
                    Map<?, ?> during = (Map<?, ?>) page.evaluate("() => ({busy: document.getElementById('ow-reply').getAttribute('aria-busy')," +
                        " secondAnswer: !!document.getElementById('ow-second-answer'), href: location.href})");
                    evidence.put("whileOwned", during);
                    evidence.put("requestsWhileOwned", List.copyOf(ownerRequests));
                    require(ownerRequests.size() == 1, "a second submit into an owned target was sent: " + ownerRequests);
                    require(formPage.equals(during.get("href")) && "true".equals(during.get("busy"))
                            && Boolean.FALSE.equals(during.get("secondAnswer")),
                        "the owned target was released or replaced early: " + during);
                    heldOwners.get(0).fulfill(new Route.FulfillOptions().setContentType("text/html")
                        .setBody("<p id=\"ow-first-answer\">first</p>" + second));
                    page.waitForSelector("#ow-first-answer");
                    page.waitForTimeout(300);
                    Map<?, ?> after = (Map<?, ?>) page.evaluate("() => ({busy: document.getElementById('ow-reply').getAttribute('aria-busy')," +
                        " first: !!document.getElementById('ow-first-answer'), secondAnswer: !!document.getElementById('ow-second-answer')})");
                    evidence.put("afterOwner", after);
                    require(after.get("busy") == null && Boolean.TRUE.equals(after.get("first")) && Boolean.FALSE.equals(after.get("secondAnswer")),
                        "the owner's answer did not land alone: " + after);
                    // The released target takes the next submit.
                    page.click("#ow-second button");
                    page.waitForSelector("#ow-second-answer");
                    evidence.put("requests", List.copyOf(ownerRequests));
                    require(ownerRequests.size() == 2 && !ownerRequests.get(1).endsWith(" document"),
                        "the released target did not take the next background submit: " + ownerRequests);
                });
        }
    }

    // imagesequence against its own scope after the page moves on: a
    // borrowed scope tabindex ends when focus arrives elsewhere even
    // without a blur on the scope, and a sequence bound before the
    // document's load re-measures at it as its scrollscrub scope does.
    private static void imagesequenceLeaseAndLoadRegressions(Browser browser, String engine) {
        String leaseCss = "#fl-scope{height:900px}#fl-host{display:block;width:320px;height:180px;" +
            "background-size:cover;background-image:url('/checks/fl-frame-0-320x180.png')}#fl-tail{height:2000px}" +
            // A fixed field takes focus without scrolling the page, so a
            // reload restores the authored start the intro waits at.
            "#fl-field{position:fixed;top:0;right:0}";
        String leaseBody = "<div id=\"fl-slot\"><section id=\"fl-scope\" data-paste-scrollscrub" +
            " data-scrub-start=\"top top\" data-scrub-end=\"bottom top\">" +
            "<i id=\"fl-host\" data-paste-imagesequence=\"#fl-frames\" data-sequence-from=\"0\" data-sequence-to=\"2\"" +
            " data-sequence-intro-from=\"0\" data-sequence-intro-to=\"2\" data-sequence-intro-duration-ms=\"60000\"" +
            " data-sequence-intro-skip=\"#fl-skip\"></i>" +
            "<button id=\"fl-skip\" type=\"button\" hidden>Skip animation</button>" +
            "<script type=\"application/json\" id=\"fl-frames\">" + catalogJson("fl", 3, 320, 180, 0, 0) + "</script>" +
            "</section></div><input id=\"fl-field\" aria-label=\"field\"><div id=\"fl-tail\"></div>";
        // Another script on the page may swallow a blur before it reaches
        // the scope (a capturing window listener); the count records
        // whether the scope's own blur listeners heard one.
        String leaseAfter = "window.flSwallow = false; window.flScopeBlurs = 0;" +
            " window.addEventListener('blur', e => { if (window.flSwallow && e.target.id === 'fl-scope') e.stopImmediatePropagation(); }, true);" +
            " document.getElementById('fl-scope').addEventListener('blur', () => { window.flScopeBlurs += 1; });";
        String leaseRead = "() => { const s = document.getElementById('fl-scope'), a = document.activeElement;" +
            " return {active: a ? (a.id || a.tagName) : null, tabindex: s.getAttribute('tabindex'), scopeBlurs: window.flScopeBlurs}; }";
        String scopeHoldsLease = "() => document.activeElement === document.getElementById('fl-scope') &&" +
            " document.getElementById('fl-scope').getAttribute('tabindex') === '-1'";

        // A focused skip retiring moves focus to the scope under a borrowed
        // tabindex. A blur delivered while the scope stays focused (the
        // window losing focus) keeps it; focus arriving anywhere else in
        // the document ends it — after a blur on the scope, after none
        // (a scope taken out of the document and put back, which some
        // engines do without a blur), and after one another script
        // swallowed.
        scenario(browser, engine, "imagesequence ends a borrowed scope tabindex when focus arrives elsewhere without a blur", null,
            context -> routeCheckPage(context, "sequence-focus-lease.html",
                checkPage(leaseCss, leaseBody, SEQUENCE_SCRIPTS, leaseAfter), null),
            (page, evidence) -> {
                Runnable skipToScope = () -> {
                    page.waitForFunction("() => !document.getElementById('fl-skip').hidden", null,
                        new Page.WaitForFunctionOptions().setTimeout(6000));
                    page.focus("#fl-skip");
                    page.keyboard().press("Enter");
                    awaitActive(page, scopeHoldsLease);
                    require(Boolean.TRUE.equals(page.evaluate("() => document.getElementById('fl-skip').hidden")),
                        "the skip control stayed visible after skipping");
                };

                openCheckPage(page, "sequence-focus-lease.html");
                skipToScope.run();
                page.evaluate("() => document.getElementById('fl-scope').dispatchEvent(new FocusEvent('blur'))");
                Map<?, ?> windowBlur = (Map<?, ?>) page.evaluate(leaseRead);
                evidence.put("windowBlur", windowBlur);
                require("fl-scope".equals(windowBlur.get("active")) && "-1".equals(windowBlur.get("tabindex")),
                    "a blur while the scope kept focus ended the borrowed tabindex: " + windowBlur);
                page.focus("#fl-field");
                frames(page);
                Map<?, ?> movedOn = (Map<?, ?>) page.evaluate(leaseRead);
                evidence.put("movedOn", movedOn);
                require(movedOn.get("tabindex") == null,
                    "the borrowed tabindex outlived focus moving to the field: " + movedOn);

                page.reload(new Page.ReloadOptions().setWaitUntil(WaitUntilState.LOAD));
                skipToScope.run();
                page.evaluate("() => { const s = document.getElementById('fl-scope'), p = s.parentNode;" +
                    " window.flScopeBlurs = 0; p.removeChild(s); p.appendChild(s); }");
                frames(page);
                evidence.put("reinserted", page.evaluate(leaseRead));
                page.focus("#fl-field");
                frames(page);
                Map<?, ?> afterReinsert = (Map<?, ?>) page.evaluate(leaseRead);
                evidence.put("afterReinsert", afterReinsert);
                require(afterReinsert.get("tabindex") == null,
                    "focus arriving at the field left the reinserted scope's borrowed tabindex: " + afterReinsert);

                page.reload(new Page.ReloadOptions().setWaitUntil(WaitUntilState.LOAD));
                skipToScope.run();
                page.evaluate("() => { window.flScopeBlurs = 0; window.flSwallow = true; }");
                page.focus("#fl-field");
                frames(page);
                Map<?, ?> swallowed = (Map<?, ?>) page.evaluate(leaseRead);
                evidence.put("swallowed", swallowed);
                active("fl-field".equals(swallowed.get("active")) && ((Number) swallowed.get("scopeBlurs")).intValue() == 0,
                    "focus reached the field and the page swallowed the scope's blur: " + swallowed);
                require(swallowed.get("tabindex") == null,
                    "focus arriving at the field left the borrowed tabindex after a swallowed blur: " + swallowed);
            });

        // An image without dimensions above the subject, inside a wrapper
        // whose own size is fixed, finishes after both modules bound: it
        // moves the subject while no observed box resizes and no scroll or
        // resize fires. The document's load is the only signal; scrollscrub
        // re-measures at it, and the sequence on the same declaration must
        // paint the frame that progress names.
        List<Route> heldLate = new ArrayList<>();
        scenario(browser, engine, "imagesequence agrees with its scrollscrub scope after a late load moves the subject", null,
            context -> {
                routeCheckPage(context, "sequence-late-load.html", checkPage(
                    "html,body,#ll-app{height:100%}#ll-late{display:block}#ll-scope{height:1000px}" +
                    "#ll-host{display:block;width:320px;height:180px;background-size:cover;" +
                    "background-image:url('/checks/ll-frame-0-320x180.png')}#ll-tail{height:3000px}",
                    "<div id=\"ll-app\"><img id=\"ll-late\" src=\"/checks/ll-late-800x400.png\" alt=\"\">" +
                    "<section id=\"ll-scope\" data-paste-scrollscrub data-scrub-start=\"top bottom\" data-scrub-end=\"bottom top\">" +
                    "<i id=\"ll-host\" data-paste-imagesequence=\"#ll-frames\" data-sequence-from=\"0\" data-sequence-to=\"9\"></i>" +
                    "<script type=\"application/json\" id=\"ll-frames\">" + catalogJson("ll", 10, 320, 180, 0, 0) + "</script>" +
                    "</section><div id=\"ll-tail\"></div></div>",
                    SEQUENCE_SCRIPTS, null), null);
                // Held until the check releases it: both modules bind while
                // the document is still loading.
                context.route(url + "checks/ll-late-800x400.png", heldLate::add);
            },
            (page, evidence) -> {
                heldLate.clear();
                Response navigation = page.navigate(url + "checks/sequence-late-load.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.DOMCONTENTLOADED));
                require(navigation != null && navigation.ok(), "regression page sequence-late-load.html loads");
                String read = "() => { const s = document.getElementById('ll-scope'), vh = document.documentElement.clientHeight," +
                    " r = s.getBoundingClientRect(), v = getComputedStyle(document.getElementById('ll-host')).backgroundImage," +
                    " m = /ll-frame-(\\d+)-/.exec(v);" +
                    " return {published: parseFloat(s.style.getPropertyValue('--paste-scrub-progress'))," +
                    " truth: Math.min(1, Math.max(0, (vh - r.top) / (vh + r.height))), top: r.top," +
                    " painted: m ? Number(m[1]) : -1, readyState: document.readyState}; }";
                String agrees = "() => { const x = (" + read + ")(); const n = 10," +
                    " expected = Math.min(n - 1, Math.floor(x.published * n));" +
                    " return Math.abs(x.published - x.truth) < 0.002 && x.painted === expected; }";
                awaitActive(page, agrees, null, new Page.WaitForFunctionOptions().setTimeout(6000));
                // Every preparation the first paint started has settled
                // before the release, so only the load can re-measure.
                page.waitForTimeout(500);
                frames(page);
                Map<?, ?> before = (Map<?, ?>) page.evaluate(read);
                evidence.put("beforeLoad", before);
                require(!"complete".equals(before.get("readyState")), "the document finished loading before the image was released");
                page.waitForCondition(() -> !heldLate.isEmpty());
                try {
                    heldLate.get(0).fulfill(new Route.FulfillOptions().setContentType("image/png").setBodyBytes(png(800, 400, 11)));
                } catch (Exception error) {
                    throw new IllegalStateException(error);
                }
                page.waitForFunction("() => document.readyState === 'complete'");
                frames(page);
                Map<?, ?> after = (Map<?, ?>) page.evaluate(read);
                long deadline = System.nanoTime() + 3_000_000_000L;
                while (!Boolean.TRUE.equals(page.evaluate(agrees)) && System.nanoTime() < deadline) {
                    page.waitForTimeout(50);
                    after = (Map<?, ?>) page.evaluate(read);
                }
                evidence.put("afterLoad", after);
                active(((Number) after.get("top")).doubleValue() > ((Number) before.get("top")).doubleValue() + 100,
                    "the late image moved the subject down: " + before + " -> " + after);
                double published = ((Number) after.get("published")).doubleValue();
                require(Math.abs(published - ((Number) after.get("truth")).doubleValue()) < 0.002,
                    "the scope's published progress missed the late layout: " + after);
                int expected = expectedIndex(0, 9, published);
                require(((Number) after.get("painted")).intValue() == expected,
                    "the sequence painted frame " + after.get("painted") + " but its scope's progress " + published +
                    " names frame " + expected + ": " + before + " -> " + after);
            });
    }

    // Quirks-mode fragment resolution as the engines do it: Chromium and
    // WebKit also take the first <a name> that matches without regard to
    // case, even ahead of an exact match, and Firefox does not. Each
    // assertion applies where the engine resolved the fragment that way.
    private static void quirksFragmentRegressions(Browser browser, String engine) {
        String clearanceRule;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            clearanceRule = rule.find() ? rule.group(1) + "{" + rule.group(2) + "51px" + rule.group(3) + "}" : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
        String[] scripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
            "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
            "/js/paste/polyfills/getcomputedstyle.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/mediaquery.js",
            "/js/paste/ui/heroscroll.js", "/js/paste/ui/smoothscroll.js"};
        // No doctype: the document is in quirks mode.
        java.util.function.BiFunction<String, String, String> quirksPage = (style, body) -> {
            StringBuilder html = new StringBuilder("<html lang=\"en\"><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:sans-serif}")
                .append(style).append("</style></head><body>").append(body);
            for (String src : scripts) {
                html.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
            }
            return html.append("</body></html>").toString();
        };

        // A hero's own entry empties a fragment the browser resolves to an
        // anchor by case-folded name, so Back and Forward show the heroes.
        scenario(browser, engine, "heroscroll entry in a quirks-mode document empties a fragment naming an anchor regardless of case", null,
            context -> routeCheckPage(context, "hero-quirks.html", quirksPage.apply(
                "html{scroll-behavior:auto}" + clearanceRule + "#hq-nav{position:fixed;top:0;left:0;right:0;height:51px;background:#fff;z-index:2}" +
                "#hq-slot{height:51px}.paste-ui-hero{position:relative;height:700px;margin:0}.paste-ui-hero-content{padding:40px}" +
                ".gap{height:400px}#hq-tail{height:3000px}",
                "<div id=\"hq-nav\">nav</div><div id=\"hq-slot\"></div>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one</div></section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">three</div></section>" +
                "<section class=\"paste-ui-hero\"><div class=\"paste-ui-hero-content\">four</div></section>" +
                "<div class=\"gap\"><a name=\"HQ-Contact\">contact</a></div><div id=\"hq-tail\">tail</div>"), null),
            (page, evidence) -> {
                Response navigation = page.navigate(url + "checks/hero-quirks.html#hq-contact",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "regression page hero-quirks.html loads");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                boolean folds = Boolean.TRUE.equals(page.evaluate("() => document.querySelector(':target') === document.getElementsByName('HQ-Contact')[0]"));
                evidence.put("engineFoldsNames", folds);
                page.evaluate("() => scrollTo(0, 0)");
                page.waitForFunction("() => scrollY === 0");
                page.mouse().click(20, 151);
                frames(page);
                page.mouse().click(20, 151);
                frames(page);
                Map<?, ?> after = (Map<?, ?>) page.evaluate("() => ({href: location.href, hash: location.hash, y: scrollY})");
                evidence.put("afterClicks", after);
                active(Math.abs(((Number) page.evaluate("() => document.querySelectorAll('.paste-ui-hero')[2].getBoundingClientRect().top")).doubleValue() - 51) <= 1,
                    "two hash clicks reached the third hero");
                if (folds) {
                    require(String.valueOf(after.get("href")).endsWith("hero-quirks.html#") && "".equals(after.get("hash")),
                        "the entry still names #hq-contact, which this engine resolves to the anchor: " + after);
                }
                List<Object> steps = new ArrayList<>();
                String[][] traversal = {{"back", "1"}, {"back", "0"}, {"forward", "1"}, {"forward", "2"}};
                for (String[] step : traversal) {
                    page.evaluate(step[0].equals("back") ? "() => history.back()" : "() => history.forward()");
                    int hero = Integer.parseInt(step[1]);
                    try {
                        page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1",
                            hero, new Page.WaitForFunctionOptions().setTimeout(3000));
                    } catch (PlaywrightException error) {
                        evidence.put("steps", steps);
                        require(false, step[0] + " did not return to hero " + (hero + 1) + ": y=" +
                            page.evaluate("() => scrollY") + " " + page.evaluate("() => location.href"));
                    }
                    steps.add(page.evaluate("() => ({hash: location.hash, y: scrollY})"));
                }
                evidence.put("steps", steps);
            });

        // The first case-folded anchor comes before the exact one; focus
        // follows whichever the browser made its :target.
        scenario(browser, engine, "smoothscroll in a quirks-mode document focuses the browser's target ahead of an exact name", null,
            context -> routeCheckPage(context, "fragment-quirks-order.html", quirksPage.apply(
                "html{scroll-behavior:auto}.gap{height:1500px}",
                "<nav class=\"paste-ui-section-nav\"><a id=\"so-go\" href=\"#so-sec\">sec</a></nav>" +
                "<input id=\"so-field\" aria-label=\"Field\"><div class=\"gap\"></div><a name=\"SO-SEC\" id=\"so-upper\">upper</a>" +
                "<div class=\"gap\"></div><a name=\"so-sec\" id=\"so-lower\">lower</a><div class=\"gap\"></div>"), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-quirks-order.html");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                page.focus("#so-field");
                page.click("#so-go");
                page.waitForFunction("() => location.hash === '#so-sec'");
                page.waitForTimeout(500);
                Map<?, ?> state = (Map<?, ?>) page.evaluate("() => { const t = document.querySelector(':target');" +
                    " return {target: t ? t.id : null, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName)}; }");
                evidence.put("landed", state);
                active(state.get("target") != null, "the browser targeted an anchor (" + state.get("target") + ")");
                require(String.valueOf(state.get("target")).equals(state.get("active")),
                    "focus must follow the browser's own :target: " + state);
            });
    }

    // Chromium matches quirks-mode names without regard to case for most
    // letters: the long s, the Kelvin sign, final sigma, the micro sign and
    // letters outside the basic plane (Deseret, Adlam) fold with their
    // letters; the dotless i does not. Firefox and WebKit fold less
    // or not at all. Focus and the hero entry's address follow what each
    // engine resolved.
    private static void quirksCaseFoldRegressions(Browser browser, String engine) {
        String clearanceRule;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            clearanceRule = rule.find() ? rule.group(1) + "{" + rule.group(2) + "51px" + rule.group(3) + "}" : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
        String[] scripts = {
            "/js/paste/paste.js", "/js/paste/guid.js", "/js/paste/util.js", "/js/paste/oop.js",
            "/js/paste/dom.js", "/js/paste/event.js", "/js/paste/has.js",
            "/js/paste/polyfills/getcomputedstyle.js",
            "/js/paste/ui/utilities/animation-frame.js", "/js/paste/ui/utilities/mediaquery.js",
            "/js/paste/ui/heroscroll.js", "/js/paste/ui/smoothscroll.js"};
        // No doctype: the document is in quirks mode.
        java.util.function.BiFunction<String, String, String> quirksPage = (style, body) -> {
            StringBuilder html = new StringBuilder("<html lang=\"en\"><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:sans-serif}")
                .append(style).append("</style></head><body>").append(body);
            for (String src : scripts) {
                html.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
            }
            return html.append("</body></html>").toString();
        };

        // {link id, href fragment, anchor name, anchor id}
        String[][] pairs = {
            {"qf-go-long", "#QF-SONG", "qf-ſong", "qf-longs"},
            {"qf-go-kelvin", "#qf-kelvin", "qf-Kelvin", "qf-kelvins"},
            {"qf-go-sigma", "#qf-Σ", "qf-ς", "qf-sigma"},
            {"qf-go-micro", "#qf-μ", "qf-µ", "qf-micro"},
            {"qf-go-deseret", "#qf-\uD801\uDC00x", "qf-\uD801\uDC28x", "qf-deseret"},
            {"qf-go-adlam", "#qf-\uD83A\uDD00", "qf-\uD83A\uDD22", "qf-adlam"},
            {"qf-go-dotless", "#qf-I", "qf-ı", "qf-dotless"},
            {"qf-go-exact", "#qf-exact", "qf-exact", "qf-exacts"}};
        StringBuilder nav = new StringBuilder("<nav class=\"paste-ui-section-nav\">");
        StringBuilder anchors = new StringBuilder();
        for (String[] pair : pairs) {
            nav.append("<a id=\"").append(pair[0]).append("\" href=\"").append(pair[1]).append("\">").append(pair[0]).append("</a> ");
            anchors.append("<div class=\"gap\"></div><a name=\"").append(pair[2]).append("\" id=\"").append(pair[3]).append("\">")
                .append(pair[3]).append("</a>");
        }
        nav.append("</nav><input id=\"qf-field\" aria-label=\"Field\">");
        scenario(browser, engine, "smoothscroll in a quirks-mode document follows the engine's case folding of names", null,
            context -> routeCheckPage(context, "fragment-quirks-fold.html", quirksPage.apply(
                "html{scroll-behavior:auto}.gap{height:1200px}", nav + anchors.toString() + "<div class=\"gap\"></div>"), null),
            (page, evidence) -> {
                openCheckPage(page, "fragment-quirks-fold.html");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                Map<String, Object> landed = new LinkedHashMap<>();
                List<String> disagreements = new ArrayList<>();
                for (String[] pair : pairs) {
                    page.focus("#qf-field");
                    String hash = (String) page.evaluate("id => document.getElementById(id).hash", pair[0]);
                    page.click("#" + pair[0]);
                    page.waitForFunction("h => location.hash === h", hash);
                    page.waitForTimeout(400);
                    Map<?, ?> state = (Map<?, ?>) page.evaluate("() => { const t = document.querySelector(':target');" +
                        " return {target: t ? t.id : null, active: document.activeElement && (document.activeElement.id || document.activeElement.tagName)}; }");
                    landed.put(pair[0], state);
                    Object target = state.get("target");
                    // With no target, no anchor may hold focus.
                    boolean agrees = target != null ? target.equals(state.get("active"))
                        : java.util.Arrays.stream(pairs).noneMatch(other -> other[3].equals(state.get("active")));
                    if (!agrees) disagreements.add(pair[0]);
                }
                evidence.put("landed", landed);
                require(disagreements.isEmpty(), "focus did not follow the browser's own :target for " + disagreements + ": " + landed);
                page.focus("#qf-field");
                page.click("#qf-go-long");
                page.click("#qf-go-exact");
                awaitActive(page, "() => document.activeElement === document.getElementById('qf-exacts')");
            });

        // The hero's own entry empties a fragment the engine resolved to an
        // anchor through case folding, so Back and Forward show heroes.
        scenario(browser, engine, "heroscroll entry in a quirks-mode document empties a fragment the engine resolves by case folding", null,
            context -> routeCheckPage(context, "hero-quirks-fold.html", quirksPage.apply(
                "html{scroll-behavior:auto}" + clearanceRule + "#hf-nav{position:fixed;top:0;left:0;right:0;height:51px;background:#fff;z-index:2}" +
                "#hf-slot{height:51px}.paste-ui-hero{position:relative;height:700px;margin:0}.paste-ui-hero-content{padding:40px}" +
                ".gap{height:400px}#hf-tail{height:3000px}",
                "<div id=\"hf-nav\">nav</div><div id=\"hf-slot\"></div>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one</div></section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>" +
                "<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">three</div></section>" +
                "<section class=\"paste-ui-hero\"><div class=\"paste-ui-hero-content\">four</div></section>" +
                "<div class=\"gap\"><a name=\"hf-ſection\" id=\"hf-anchor\">section</a></div><div id=\"hf-tail\">tail</div>"), null),
            (page, evidence) -> {
                Response navigation = page.navigate(url + "checks/hero-quirks-fold.html#HF-SECTION",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "regression page hero-quirks-fold.html loads");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                boolean folds = Boolean.TRUE.equals(page.evaluate("() => document.querySelector(':target') === document.getElementById('hf-anchor')"));
                evidence.put("engineFoldsLongS", folds);
                page.evaluate("() => scrollTo(0, 0)");
                page.waitForFunction("() => scrollY === 0");
                page.mouse().click(20, 151);
                frames(page);
                page.mouse().click(20, 151);
                frames(page);
                Map<?, ?> after = (Map<?, ?>) page.evaluate("() => ({href: location.href, hash: location.hash, y: scrollY})");
                evidence.put("afterClicks", after);
                active(Math.abs(((Number) page.evaluate("() => document.querySelectorAll('.paste-ui-hero')[2].getBoundingClientRect().top")).doubleValue() - 51) <= 1,
                    "two hash clicks reached the third hero");
                if (folds) {
                    require(String.valueOf(after.get("href")).endsWith("hero-quirks-fold.html#") && "".equals(after.get("hash")),
                        "the entry still names #HF-SECTION, which this engine resolves to the anchor: " + after);
                }
                List<Object> steps = new ArrayList<>();
                String[][] traversal = {{"back", "1"}, {"back", "0"}, {"forward", "1"}, {"forward", "2"}};
                for (String[] step : traversal) {
                    page.evaluate(step[0].equals("back") ? "() => history.back()" : "() => history.forward()");
                    int hero = Integer.parseInt(step[1]);
                    try {
                        page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1",
                            hero, new Page.WaitForFunctionOptions().setTimeout(3000));
                    } catch (PlaywrightException error) {
                        evidence.put("steps", steps);
                        require(false, step[0] + " did not return to hero " + (hero + 1) + ": y=" +
                            page.evaluate("() => scrollY") + " " + page.evaluate("() => location.href"));
                    }
                    steps.add(page.evaluate("() => ({hash: location.hash, y: scrollY})"));
                }
                evidence.put("steps", steps);
            });
    }

    // A name outside the basic plane is one code point in two code units;
    // Chromium folds it in quirks mode (Deseret capital and small letters),
    // so the hero's own entry empties a fragment naming it.
    private static void quirksSurrogateFoldRegressions(Browser browser, String engine) {
        String clearanceRule;
        try {
            String mixin = Files.readString(Path.of("modules/sectionnav/_mixin.scss"));
            Matcher rule = Pattern.compile("(:where\\([^)]*\\))\\s*\\{([^}]*?)#\\{\\$clearance\\}([^}]*)\\}").matcher(mixin);
            clearanceRule = rule.find() ? rule.group(1) + "{" + rule.group(2) + "51px" + rule.group(3) + "}" : "";
        } catch (java.io.IOException error) {
            throw new IllegalStateException(error);
        }
        StringBuilder html = new StringBuilder("<html lang=\"en\"><head><meta charset=\"utf-8\"><style>body{margin:0;font-family:sans-serif}")
            .append("html{scroll-behavior:auto}").append(clearanceRule)
            .append("#hd-nav{position:fixed;top:0;left:0;right:0;height:51px;background:#fff;z-index:2}")
            .append("#hd-slot{height:51px}.paste-ui-hero{position:relative;height:700px;margin:0}.paste-ui-hero-content{padding:40px}")
            .append(".gap{height:400px}#hd-tail{height:3000px}</style></head><body>")
            .append("<div id=\"hd-nav\">nav</div><div id=\"hd-slot\"></div>")
            .append("<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">one</div></section>")
            .append("<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">two</div></section>")
            .append("<section class=\"paste-ui-hero\" data-hero-hashclick><div class=\"paste-ui-hero-content\">three</div></section>")
            .append("<section class=\"paste-ui-hero\"><div class=\"paste-ui-hero-content\">four</div></section>")
            .append("<div class=\"gap\"><a name=\"hd-𐐨x\" id=\"hd-anchor\">deseret</a></div><div id=\"hd-tail\">tail</div>");
        for (String src : HEROSCROLL_SCRIPTS) {
            html.append("<script src=\"").append(url).append(src, 1, src.length()).append("\"></script>\n");
        }
        html.append("</body></html>");
        scenario(browser, engine, "heroscroll entry in a quirks-mode document empties a fragment naming a letter outside the basic plane by case", null,
            context -> routeCheckPage(context, "hero-quirks-deseret.html", html.toString(), null),
            (page, evidence) -> {
                Response navigation = page.navigate(url + "checks/hero-quirks-deseret.html#HD-%F0%90%90%80X",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "regression page hero-quirks-deseret.html loads");
                require("BackCompat".equals(page.evaluate("() => document.compatMode")), "precondition: the page is in quirks mode");
                boolean folds = Boolean.TRUE.equals(page.evaluate("() => document.querySelector(':target') === document.getElementById('hd-anchor')"));
                evidence.put("engineFoldsDeseret", folds);
                page.evaluate("() => scrollTo(0, 0)");
                page.waitForFunction("() => scrollY === 0");
                page.mouse().click(20, 151);
                frames(page);
                page.mouse().click(20, 151);
                frames(page);
                Map<?, ?> after = (Map<?, ?>) page.evaluate("() => ({href: location.href, hash: location.hash, y: scrollY})");
                evidence.put("afterClicks", after);
                active(Math.abs(((Number) page.evaluate("() => document.querySelectorAll('.paste-ui-hero')[2].getBoundingClientRect().top")).doubleValue() - 51) <= 1,
                    "two hash clicks reached the third hero");
                if (folds) {
                    require(String.valueOf(after.get("href")).endsWith("hero-quirks-deseret.html#") && "".equals(after.get("hash")),
                        "the entry still names a fragment this engine resolves to the anchor: " + after);
                }
                List<Object> steps = new ArrayList<>();
                String[][] traversal = {{"back", "1"}, {"back", "0"}, {"forward", "1"}, {"forward", "2"}};
                for (String[] step : traversal) {
                    page.evaluate(step[0].equals("back") ? "() => history.back()" : "() => history.forward()");
                    int hero = Integer.parseInt(step[1]);
                    try {
                        page.waitForFunction("n => Math.abs(document.querySelectorAll('.paste-ui-hero')[n].getBoundingClientRect().top - 51) <= 1",
                            hero, new Page.WaitForFunctionOptions().setTimeout(3000));
                    } catch (PlaywrightException error) {
                        evidence.put("steps", steps);
                        require(false, step[0] + " did not return to hero " + (hero + 1) + ": y=" +
                            page.evaluate("() => scrollY") + " " + page.evaluate("() => location.href"));
                    }
                    steps.add(page.evaluate("() => ({hash: location.hash, y: scrollY})"));
                }
                evidence.put("steps", steps);
            });
    }

    private static void runBrowser(Playwright playwright, String engine) {
        BrowserType type = switch (engine) {
            case "chromium" -> playwright.chromium();
            case "firefox" -> playwright.firefox();
            case "webkit" -> playwright.webkit();
            default -> throw new IllegalArgumentException("Unknown browser engine: " + engine);
        };
        BrowserType.LaunchOptions launch = new BrowserType.LaunchOptions().setHeadless(true);
        String executable = System.getenv("ELEMENTS_CHROMIUM_EXECUTABLE");
        if (engine.equals("chromium") && executable != null && !executable.isBlank()) {
            launch.setExecutablePath(Path.of(executable));
        }
        try (Browser browser = type.launch(launch)) {
            System.out.println("BROWSER " + engine + " " + browser.version());

            scenario(browser, engine, "the fixture host refuses every undeclared path", null, (page, evidence) -> {
                active(page.request().get(url + "examples/reading.html").ok(), "a declared fixture path is served");
                for (String missing : List.of(
                        "examples/nothere.html",
                        "js/paste/ui/nothere.js",
                        "generated/sequence/nope/t0/frame-0.png",
                        "generated/img/nope/r0.png")) {
                    APIResponse response = page.request().get(url + missing);
                    require(response.status() == 404, missing + " returned " + response.status() + ", not 404");
                }
                evidence.put("probed", 4);
            });

            scenario(browser, engine, "scrollscrub publishes authored progress under real events", null, (page, evidence) -> {
                Response navigation = page.navigate(url + "examples/reading.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "reading fixture loads");
                List<Double> readings = new ArrayList<>();
                for (double fraction : new double[]{0, 0.25, 0.5, 0.75, 1, 0.5}) {
                    scrollTo(page, fraction);
                    page.waitForTimeout(120);
                    readings.add(property(page, "#reading"));
                }
                evidence.put("progressReadings", readings);
                active(readings.get(0) < readings.get(2) && readings.get(2) < readings.get(4),
                    "progress did not climb across the traverse: " + readings);
                require(readings.get(5) < readings.get(3), "scrolling back lowers the published progress");
                double scale = ((Number) page.evaluate(
                    "() => new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.meter-fill')).transform).a"))
                    .doubleValue();
                evidence.put("meterScaleX", scale);
                require(scale > 0 && scale <= 1, "CSS consumed the published property: scaleX=" + scale);
            });

            scenario(browser, engine, "the one-shot document load subscription retires", null, (page, evidence) -> {
                Response navigation = page.navigate(url + "examples/reading.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "reading fixture loads");
                page.waitForFunction("() => document.readyState === 'complete'");
                scrollTo(page, 0.5);
                page.waitForTimeout(120);
                double before = property(page, "#reading");
                // Moving the subject does not itself re-measure: a relative
                // offset changes no box size, so no scroll, resize or observed
                // size change (the scope's or the document's) carries that
                // shift. A second load event is the probe — executeCount=1
                // must have retired the correction pass, so the stale
                // reading stands.
                page.evaluate("""
                    () => {
                      const reading = document.querySelector('#reading');
                      reading.style.position = 'relative';
                      reading.style.top = '80vh';
                    }
                    """);
                page.evaluate("() => window.dispatchEvent(new Event('load'))");
                page.waitForTimeout(120);
                double afterSyntheticLoad = property(page, "#reading");
                evidence.put("before", before);
                evidence.put("afterSyntheticLoad", afterSyntheticLoad);
                require(afterSyntheticLoad == before,
                    "a second load re-measured — the one-shot subscription did not retire: " + before + " -> " + afterSyntheticLoad);
                // The measurement pipeline itself is still alive: a real
                // scroll input re-reads the shifted geometry.
                scrollTo(page, 0.6);
                page.waitForTimeout(120);
                double afterScroll = property(page, "#reading");
                evidence.put("afterScroll", afterScroll);
                active(afterScroll != before, "a real scroll no longer measures — the module was frozen, not retired");
            });

            scenario(browser, engine, "imagesequence intro plays once then the declared range scrubs", null, (page, evidence) -> {
                Response navigation = page.navigate(url + "examples/sequence-hero.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "sequence fixture loads");
                // Both hosts paint catalog frames through the real loader.
                awaitActive(page, "() => /frame-\\d+\\.png/.test(getComputedStyle(document.querySelector('#press-host')).backgroundImage)");
                awaitActive(page, "() => /frame-\\d+\\.png/.test(getComputedStyle(document.querySelector('#hall-host')).backgroundImage)");
                // The authored skip control is exposed only while the intro
                // can be skipped; taking it completes the intro early.
                Locator skip = page.locator("#press-skip");
                skip.waitFor(new Locator.WaitForOptions().setTimeout(6000));
                skip.click();
                require((Boolean) page.evaluate("() => document.querySelector('#press-skip').hidden"),
                    "the skip control stayed visible after skipping");
                // Scroll owns the declared reverse range 11 -> 3 across the
                // windowed traverse of the press section.
                List<Map<String, Object>> frames = new ArrayList<>();
                for (double fraction : new double[]{0.3, 0.45, 0.6}) {
                    scrollTo(page, fraction);
                    page.waitForTimeout(150);
                    double progress = property(page, "#press-hero");
                    int painted = paintedFrameIndex(page, "#press-host");
                    int expected = expectedIndex(11, 3, progress);
                    frames.add(Map.of("fraction", fraction, "progress", progress, "painted", painted, "expected", expected));
                    require(painted == expected,
                        "press painted frame " + painted + " but the declaration expects " + expected + " at progress " + progress);
                }
                evidence.put("pressFrames", frames);
                // The hall sequence plays the forward direction.
                scrollTo(page, 0.85);
                page.waitForTimeout(150);
                double hallProgress = property(page, "#hall-hero");
                int hallPainted = paintedFrameIndex(page, "#hall-host");
                int hallExpected = expectedIndex(0, 15, hallProgress);
                evidence.put("hall", Map.of("progress", hallProgress, "painted", hallPainted, "expected", hallExpected));
                require(hallPainted == hallExpected,
                    "hall painted frame " + hallPainted + " but the declaration expects " + hallExpected + " at progress " + hallProgress);
            });

            scenario(browser, engine, "reduced motion keeps the authored poster and never runs the intro",
                Map.of("reducedMotion", ReducedMotion.REDUCE), null, (page, evidence) -> {
                // Any request for a catalog frame other than the authored
                // reduced-motion poster is animated work the module must
                // not take; the stylesheet alone only ever asks for the
                // poster, so this is the module's own behaviour.
                List<String> nonPosterRequests = new ArrayList<>();
                Pattern frameRequest = Pattern.compile("/generated/sequence/(catalog-press|gallery-hall)/t\\d+/frame-(\\d+)\\.png");
                page.onRequest(request -> {
                    Matcher frame = frameRequest.matcher(request.url());
                    if (frame.find()) {
                        int poster = frame.group(1).equals("catalog-press") ? 11 : 15;
                        if (Integer.parseInt(frame.group(2)) != poster) nonPosterRequests.add(request.url());
                    }
                });
                Response navigation = page.navigate(url + "examples/sequence-hero.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "sequence fixture loads");
                // The stylesheet authors the assembled final poses for
                // reduced motion; the module must stand down entirely —
                // through the whole intro window (1400 ms declared) and
                // across every scroll position of both declared ranges,
                // not in one early sample.
                List<Map<String, Object>> samples = new ArrayList<>();
                Consumer<String> sample = where -> {
                    int press = paintedFrameIndex(page, "#press-host");
                    int hall = paintedFrameIndex(page, "#hall-host");
                    boolean skipHidden = (Boolean) page.evaluate("() => document.querySelector('#press-skip').hidden");
                    samples.add(Map.of("at", where, "press", press, "hall", hall, "skipHidden", skipHidden));
                    require(press == 11, "press reduced-motion poster replaced at " + where + ": frame " + press);
                    require(hall == 15, "hall reduced-motion poster replaced at " + where + ": frame " + hall);
                    require(skipHidden, "the skip control appeared under reduced motion at " + where);
                };
                for (int tick = 0; tick < 18; tick += 1) {
                    sample.accept("top+" + (tick * 100) + "ms");
                    page.waitForTimeout(100);
                }
                for (double fraction : new double[]{0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0}) {
                    scrollTo(page, fraction);
                    for (int tick = 0; tick < 3; tick += 1) {
                        page.waitForTimeout(100);
                        sample.accept("scroll " + fraction + "+" + ((tick + 1) * 100) + "ms");
                    }
                }
                evidence.put("samples", samples.size());
                evidence.put("nonPosterRequests", nonPosterRequests);
                require(nonPosterRequests.isEmpty(),
                    "catalog frames other than the posters were requested under reduced motion: " + nonPosterRequests);
            });

            scenario(browser, engine, "resolution upgrades follow paint size and the authored cap",
                Map.of("deviceScaleFactor", 2), null, (page, evidence) -> {
                Response navigation = page.navigate(url + "examples/avatars.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "avatars fixture loads");
                page.waitForTimeout(400);
                Map<String, String> srcs = new LinkedHashMap<>();
                for (String id : List.of("avatar", "product", "wide")) {
                    srcs.put(id, (String) page.evaluate(
                        "i => document.getElementById(i).currentSrc || document.getElementById(i).src", id));
                }
                evidence.put("sources", srcs);
                active(srcs.get("avatar").matches(".*r[12]\\.png$"),
                    "avatar should upgrade on a 2x display: " + srcs.get("avatar"));
                require(srcs.get("product").endsWith("/r1.png"),
                    "product at 240px on 2x should pick the 480 variant: " + srcs.get("product"));
                require(srcs.get("wide").endsWith("/r0.png"),
                    "the declared cap must hold the wide image at its baseline: " + srcs.get("wide"));
            });

            scenario(browser, engine, "baseline resolution stands at device ratio 1",
                Map.of("deviceScaleFactor", 1), null, (page, evidence) -> {
                Response navigation = page.navigate(url + "examples/avatars.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "avatars fixture loads");
                page.waitForTimeout(400);
                String avatar = (String) page.evaluate("() => document.getElementById('avatar').currentSrc || document.getElementById('avatar').src");
                evidence.put("avatar", avatar);
                require(avatar.endsWith("/r0.png"), "a 1x display kept the authored baseline: " + avatar);
                page.evaluate("() => document.getElementById('avatar').style.width = '400px'");
                awaitActive(page, "() => !document.getElementById('avatar').currentSrc.endsWith('/r0.png')");
            });

            // Missing-Promise negative control on an isolated page, with a
            // Promise-present positive twin on the identical page: the
            // negative's assertions only mean something if the same
            // markup, routes and context make the modules act when the
            // capability is there. In the negative the capability is
            // deleted before module evaluation, so a module without its
            // guard throws during eval and the scenario fails on the
            // captured page error. The 2x context makes the declared
            // resolution upgrade worth taking, and scrollscrub stays live
            // in both — inertness must be scoped to the Promise-dependent
            // modules.
            for (boolean promisePresent : List.of(true, false)) {
                List<String> moduleFrames = new ArrayList<>();
                List<String> moduleUpgrades = new ArrayList<>();
                String name = promisePresent
                    ? "with Promise the same isolated page enhances (positive twin)"
                    : "without Promise the enhancement modules stay inert";
                scenario(browser, engine, name,
                    Map.of("deviceScaleFactor", 2), context -> {
                        context.route("**/no-promise.html", route ->
                            route.fulfill(new Route.FulfillOptions()
                                .setContentType("text/html; charset=utf-8")
                                .setBody(noPromisePage())));
                        context.route("**/np/**", route -> {
                            String requestUrl = route.request().url();
                            if (requestUrl.matches(".*frame-\\d+\\.png$")) moduleFrames.add(requestUrl);
                            if (requestUrl.endsWith("avatar-r1.png")) moduleUpgrades.add(requestUrl);
                            try {
                                route.fulfill(new Route.FulfillOptions()
                                    .setContentType("image/png")
                                    .setBodyBytes(requestUrl.contains("avatar-r1") ? png(480, 480, 29)
                                        : requestUrl.contains("avatar-r0") ? png(240, 240, 29)
                                        : png(640, 360, 23)));
                            } catch (Exception error) {
                                route.abort();
                            }
                        });
                        if (!promisePresent) context.addInitScript("delete window.Promise;");
                    }, (page, evidence) -> {
                    Response navigation = page.navigate(url + "no-promise.html",
                        new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                    require(navigation != null && navigation.ok(), "isolated fixture loads");
                    require((Boolean) page.evaluate("() => (typeof Promise === 'function') === " + promisePresent),
                        promisePresent ? "the positive twin lost Promise" : "the negative control did not actually remove Promise");
                    // The sibling module owns its declaration either way:
                    // real scroll publishes authored progress.
                    page.waitForTimeout(200);
                    scrollTo(page, 0.6);
                    page.waitForTimeout(200);
                    double progress = property(page, "#np-hero");
                    evidence.put("scrollscrubProgress", progress);
                    active(progress > 0, "scrollscrub stopped working — inertness escaped the Promise-dependent modules");
                    if (promisePresent) {
                        // The same declarations act: the sequence fetches
                        // and paints catalog frames, the standalone image
                        // takes its declared upgrade at 2x.
                        awaitActive(page, 
                            "() => /\\/np\\/frame-\\d+\\.png/.test(getComputedStyle(document.querySelector('#np-host')).backgroundImage)");
                        awaitActive(page, 
                            "() => /avatar-r1\\.png$/.test(document.getElementById('np-avatar').currentSrc || '')");
                        evidence.put("hostBackground", page.evaluate(
                            "() => getComputedStyle(document.querySelector('#np-host')).backgroundImage"));
                        evidence.put("avatar", page.evaluate("() => document.getElementById('np-avatar').currentSrc"));
                        evidence.put("frameRequests", new ArrayList<>(moduleFrames));
                        active(!moduleFrames.isEmpty(), "the positive twin requested no catalog frames");
                        active(!moduleUpgrades.isEmpty(), "the positive twin requested no resolution upgrade");
                        return;
                    }
                    // Baseline stands: the host keeps its authored background and
                    // the standalone image keeps its authored src at 2x.
                    page.waitForTimeout(600);
                    String painted = (String) page.evaluate(
                        "() => getComputedStyle(document.querySelector('#np-host')).backgroundImage");
                    evidence.put("hostBackground", painted);
                    require(painted.contains("baseline.png"),
                        "the host lost its authored baseline or painted a catalog frame: " + painted);
                    String avatar = (String) page.evaluate(
                        "() => document.getElementById('np-avatar').currentSrc || document.getElementById('np-avatar').src");
                    evidence.put("avatar", avatar);
                    require(avatar.endsWith("avatar-r0.png"),
                        "the authored src was replaced without Promise: " + avatar);
                    require((Boolean) page.evaluate("() => document.querySelector('#np-skip').hidden"),
                        "the skip control appeared while the intro could never run");
                    require(moduleFrames.isEmpty(),
                        "catalog frames were requested without Promise: " + moduleFrames);
                    require(moduleUpgrades.isEmpty(),
                        "a resolution upgrade was requested without Promise: " + moduleUpgrades);
                });
            }

            // An unsized img (no width/height attributes, CSS width only)
            // on a forced device scale factor of 1, with a ladder that has
            // no rung at the painted width: the 300 CSS px paint needs more
            // than the 240 px base, so the smallest sufficient rung, 480,
            // must actually display. A density descriptor would leave the
            // browser on the implicit 1x src at DPR 1; the module writes a
            // width descriptor, so currentSrc proves the upgrade shows.
            List<String> dprOneRequests = new ArrayList<>();
            scenario(browser, engine, "an unsized image upgrades and displays at device ratio 1",
                Map.of("deviceScaleFactor", 1), context -> {
                    context.route("**/dpr1-unsized.html", route ->
                        route.fulfill(new Route.FulfillOptions()
                            .setContentType("text/html; charset=utf-8")
                            .setBody(dprOnePage())));
                    context.route("**/dpr1/**", route -> {
                        String requestUrl = route.request().url();
                        dprOneRequests.add(requestUrl);
                        try {
                            byte[] body = requestUrl.endsWith("up-960.png") ? png(960, 720, 31)
                                : requestUrl.endsWith("up-480.png") ? png(480, 360, 31)
                                : png(240, 180, 31);
                            route.fulfill(new Route.FulfillOptions().setContentType("image/png").setBodyBytes(body));
                        } catch (Exception error) {
                            route.abort();
                        }
                    });
                }, (page, evidence) -> {
                Response navigation = page.navigate(url + "dpr1-unsized.html",
                    new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                require(navigation != null && navigation.ok(), "DPR-1 fixture loads");
                require(((Number) page.evaluate("() => window.devicePixelRatio")).doubleValue() == 1,
                    "the context did not force device ratio 1");
                awaitActive(page, "() => /\\/dpr1\\/up-480\\.png$/.test(document.getElementById('unsized').currentSrc || '')");
                Map<?, ?> state = (Map<?, ?>) page.evaluate(
                    "() => { const i = document.getElementById('unsized');" +
                    " return {currentSrc: i.currentSrc, srcset: i.getAttribute('srcset') || '', sizes: i.getAttribute('sizes') || ''," +
                    "  hasWidthAttr: i.hasAttribute('width'), hasHeightAttr: i.hasAttribute('height'), width: i.getBoundingClientRect().width}; }");
                evidence.put("state", state);
                evidence.put("requests", dprOneRequests);
                require(!Boolean.TRUE.equals(state.get("hasWidthAttr")) && !Boolean.TRUE.equals(state.get("hasHeightAttr")),
                    "the fixture image must stay unsized");
                require(String.valueOf(state.get("currentSrc")).endsWith("/dpr1/up-480.png"),
                    "the displayed source is not the 480 upgrade: " + state.get("currentSrc"));
                require(String.valueOf(state.get("srcset")).matches(".*up-480\\.png\\s+480w\\s*$"),
                    "the module's srcset does not use a width descriptor: " + state.get("srcset"));
                require(dprOneRequests.stream().noneMatch(request -> request.endsWith("up-960.png")),
                    "the 960 rung was requested although 480 suffices: " + dprOneRequests);
            });

            behaviourRegressions(browser, engine);
            lateGeometryRegressions(browser, engine);
            imagesequenceClaimAndDecodeRegressions(browser, engine);
            progressiveresolutionBoxAndNearnessRegressions(browser, engine);
            progressiveresolutionAttachmentRegressions(browser, engine);
            fragmentFocusAndHeroLandingRegressions(browser, engine);
            heroEntryAndQuirksNameRegressions(browser, engine);
            quirksFragmentRegressions(browser, engine);
            quirksCaseFoldRegressions(browser, engine);
            quirksSurrogateFoldRegressions(browser, engine);
            imagesequenceLeaseAndLoadRegressions(browser, engine);
            animationFramePageWrapperRegressions(browser, engine);
            animationFrameDoubleCarrierRegressions(browser, engine);

            // The documented examples and their disabled-module controls run
            // on every engine: nothing in them depends on a Chromium-only
            // capability (request routing, the catalog markup and the
            // assertions are engine-neutral).
            List<String> markups;
            try {
                markups = documentedExampleMarkups();
            } catch (Exception error) {
                throw new IllegalStateException("verbatim example fixture construction failed", error);
            }
            for (int index = 0; index < markups.size(); index += 1) {
                final int exampleIndex = index;
                final int exampleNumber = index + 1;
                String markup = markups.get(index);
                // Every source the extracted catalog declares — painted
                // output must always be one of these, nothing else.
                List<String> declaredSources = declaredSourcesOf(markup);
                // The frame bases alone, in catalog order — the scroll
                // assertions name a specific index's content, not merely
                // 'some declared URL'.
                List<String> frameSources = declaredFrameSources(markup);
                require(!frameSources.isEmpty(),
                    "documented example " + exampleNumber + " declared no frames");
                boolean introDeclared = markup.contains("data-sequence-intro-duration-ms=\"");
                String skipId = skipIdOf(markup);
                Matcher fromM = Pattern.compile("data-sequence-from=\"(\\d+)\"").matcher(markup);
                Matcher toM = Pattern.compile("data-sequence-to=\"(\\d+)\"").matcher(markup);
                int from = fromM.find() ? Integer.parseInt(fromM.group(1)) : 0;
                int to = toM.find() ? Integer.parseInt(toM.group(1)) : frameSources.size() - 1;
                String toToken = frameToken(frameSources.get(to));
                // Range fractions the traverse asserts, each mapped to the
                // frame the declaration selects there: the start, the
                // middle (a frame that is neither endpoint whenever the
                // range spans three or more), and the end.
                double[] fractions = {0.05, 0.5, 1.0};
                List<String> expectedTokens = new ArrayList<>();
                for (double fraction : fractions) {
                    expectedTokens.add(frameToken(frameSources.get(expectedIndex(from, to, fraction))));
                }

                List<String> imageRequests = new ArrayList<>();
                scenario(browser, engine, "documented example " + exampleNumber + " plays verbatim in a real page", null,
                    context -> routeDocumentedExample(context, "verbatim-example-" + exampleIndex + ".html",
                        markup, declaredSources, imageRequests),
                    (page, evidence) -> {
                        Response navigation = page.navigate(url + "verbatim-example-" + exampleIndex + ".html",
                            new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                        require(navigation != null && navigation.ok(), "verbatim example page loads");
                        // The authored baseline stands immediately; the
                        // module bound at define time.
                        page.waitForFunction(
                            "() => { return /\\.(webp|png)/.test((" + paintedEvaluation() + ")()); }");
                        String baseline = String.valueOf(page.evaluate(paintedEvaluation()));
                        require(declaredSources.stream().anyMatch(baseline::contains),
                            "the authored baseline is not a declared catalog source: " + baseline);
                        // Frame identity, not resolution rung: the module may
                        // already have sharpened the baseline frame to one of
                        // its declared upgrades before this first sample.
                        String paintedToken = declaredSources.stream().filter(baseline::contains)
                            .map(ElementsBrowserChecks::frameToken).findFirst().orElse(null);
                        String baselineToken = frameSources.stream().map(ElementsBrowserChecks::frameToken)
                            .filter(token -> token.equals(paintedToken)).findFirst().orElse(null);
                        require(baselineToken != null, "the authored baseline is not a catalog frame: " + baseline);
                        evidence.put("baseline", baseline);
                        // At least one asserted frame must differ from the
                        // baseline frame — otherwise the baseline alone
                        // could satisfy every scroll assertion below.
                        require(expectedTokens.stream().anyMatch(token -> !token.equals(baselineToken)),
                            "documented example " + exampleNumber + " asserts no frame distinct from its baseline frame");
                        if (introDeclared) {
                            require(skipId != null, "the documented intro declares no skip control");
                            // Observable startup: the authored skip control
                            // surfaces only while the intro can be skipped —
                            // a DOM write no authored markup or native paint
                            // can produce.
                            page.waitForFunction(
                                "(id) => { const s = document.getElementById(id); return s && !s.hidden; }", skipId);
                            // And the painted surface leaves the baseline —
                            // the intro's own frames advance under module
                            // ownership.
                            awaitActive(page, 
                                "(baseline) => { return (" + paintedEvaluation() + ")() !== baseline; }",
                                baseline);
                            evidence.put("introStarted", true);
                            // Handoff: completion retires the control and
                            // returns ownership to scroll — only then is a
                            // scroll-driven frame change scroll's alone.
                            page.waitForFunction("(id) => document.getElementById(id).hidden", skipId);
                            evidence.put("introHandedOff", true);
                        }
                        // Start, middle and end of the declared range, each
                        // a specific frame selected by scrolling. The end
                        // scroll goes to the declaration's own end
                        // position: past it the scope leaves the near band
                        // and the module is right to release work.
                        String handoff = String.valueOf(page.evaluate(paintedEvaluation()));
                        String scopeSelector = String.valueOf(page.evaluate(scopeSelectorEvaluation()));
                        List<String> paintedTokens = new ArrayList<>();
                        for (int step = 0; step < fractions.length; step += 1) {
                            String token = expectedTokens.get(step);
                            scrollToRangeFraction(page, scopeSelector, fractions[step]);
                            awaitActive(page, 
                                "(token) => { return String((" + paintedEvaluation() + ")()).includes(token); }",
                                token);
                            paintedTokens.add(token);
                        }
                        Object painted = page.evaluate(
                            "() => { const host = document.querySelector('[data-paste-imagesequence]');" +
                            " return {tag: host.tagName," +
                            "         painted: host.tagName === 'IMG' ? (host.currentSrc || host.src)" +
                            "             : getComputedStyle(host).backgroundImage," +
                            "         width: host.tagName === 'IMG' ? host.naturalWidth : 0}; }");
                        evidence.put("painted", painted);
                        evidence.put("paintedTokens", paintedTokens);
                        require(painted.toString().contains(toToken),
                            "scroll did not paint the declared end frame " + toToken + ": " + painted);
                        // Scroll itself changed the picture: some asserted
                        // frame is neither the authored baseline frame nor
                        // what stood when scrolling began (the intro's
                        // final frame), so neither the baseline nor the
                        // intro can satisfy the traverse — and the end
                        // frame was reached from a different painted frame.
                        require(paintedTokens.stream().anyMatch(token ->
                                !token.equals(baselineToken) && !handoff.contains(token)),
                            "no scrolled frame differed from both the baseline " + baselineToken
                                + " and the pre-scroll frame " + handoff + ": " + paintedTokens);
                        require(!paintedTokens.get(paintedTokens.size() - 2).equals(toToken),
                            "the end frame " + toToken + " was already painted before the final scroll");
                        require(declaredSources.stream().anyMatch(src -> painted.toString().contains(src)),
                            "the documented example painted outside its declared catalog: " + painted);
                        // The module itself fetched catalog frames: a
                        // request for a declared frame other than the
                        // baseline's is one no authored markup issues.
                        List<String> moduleRequests = new ArrayList<>();
                        for (String request : imageRequests) {
                            if (!request.contains(baselineToken)) moduleRequests.add(request);
                        }
                        evidence.put("imageRequests", imageRequests);
                        active(!moduleRequests.isEmpty(),
                            "no declared frame beyond the baseline was ever requested: " + imageRequests);
                    });

                // The same page with the module body served empty: every
                // assertion the example above carries — painted frame
                // change, surfaced skip control, non-baseline requests —
                // must be absent, or it binds to authored markup and
                // native requests, not the module.
                List<String> controlRequests = new ArrayList<>();
                scenario(browser, engine, "documented example " + exampleNumber
                        + " assertions require the module — disabled-module control", null,
                    context -> {
                        context.route("**/js/paste/ui/imagesequence.js", route ->
                            route.fulfill(new Route.FulfillOptions()
                                .setContentType("text/javascript")
                                .setBody("/* module disabled for the negative control */")));
                        routeDocumentedExample(context, "verbatim-disabled-" + exampleIndex + ".html",
                            markup, declaredSources, controlRequests);
                    },
                    (page, evidence) -> {
                        Response navigation = page.navigate(url + "verbatim-disabled-" + exampleIndex + ".html",
                            new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
                        require(navigation != null && navigation.ok(), "disabled-control page loads");
                        page.waitForTimeout(300);
                        String before = String.valueOf(page.evaluate(paintedEvaluation()));
                        String baselineToken = frameSources.stream().filter(before::contains)
                            .map(ElementsBrowserChecks::frameToken).findFirst().orElse(null);
                        require(baselineToken != null,
                            "the disabled control does not show the authored baseline frame: " + before);
                        String scopeSelector = String.valueOf(page.evaluate(scopeSelectorEvaluation()));
                        for (double fraction : fractions) {
                            scrollToRangeFraction(page, scopeSelector, fraction);
                            page.waitForTimeout(400);
                            String now = String.valueOf(page.evaluate(paintedEvaluation()));
                            require(now.equals(before),
                                "the disabled control's paint moved without the module: " + before + " -> " + now);
                        }
                        evidence.put("painted", before);
                        if (skipId != null) {
                            require((Boolean) page.evaluate("(id) => document.getElementById(id).hidden", skipId),
                                "the disabled control surfaced the intro skip without the module");
                        }
                        List<String> nonBaseline = new ArrayList<>();
                        for (String request : controlRequests) {
                            if (!request.contains(baselineToken)) nonBaseline.add(request);
                        }
                        evidence.put("imageRequests", controlRequests);
                        require(nonBaseline.isEmpty(),
                            "frames beyond the baseline were requested without the module: " + nonBaseline);
                        evidence.put("moduleDisabled", true);
                    });
            }
        }
    }

    // animation-frame under a page's own requestAnimationFrame wrapper,
    // installed before paste loads: one that calls back with no time,
    // and a synchronous "flush" helper that calls back inside the call
    // and returns an id of its own. Twelve chained batches must each run
    // after request() returns, on the performance.now() clock, strictly
    // later than the one before and spread over real time.
    private static final String[] ANIMATION_FRAME_WRAPPER_SCRIPTS = {
        "/js/paste/paste.js", "/js/paste/ui/utilities/animation-frame.js"};

    private static void animationFramePageWrapperRegressions(Browser browser, String engine) {
        Map<String, String> wrappers = new LinkedHashMap<>();
        wrappers.put("no time", "window.afNative = window.requestAnimationFrame; (function () {" +
            " var native = window.afNative; window.requestAnimationFrame = function (cb) {" +
            " return native.call(window, function () { cb(); }); }; })();");
        wrappers.put("synchronous", "window.afNative = window.requestAnimationFrame; (function () {" +
            " var k = 0; window.requestAnimationFrame = function (cb) { cb(performance.now()); k += 1; return k; }; })();");
        for (Map.Entry<String, String> wrapper : wrappers.entrySet()) {
            String pagePath = "animation-frame-wrapper-" + (wrapper.getKey().equals("no time") ? "no-time" : "sync") + ".html";
            scenario(browser, engine, "animation-frame keeps batches on the frame clock under a page's "
                    + wrapper.getKey() + " requestAnimationFrame wrapper", null,
                context -> routeCheckPage(context, pagePath, checkPage("",
                    "<script>" + wrapper.getValue() + "</script>",
                    ANIMATION_FRAME_WRAPPER_SCRIPTS,
                    "paste.define('check.animation-frame-wrapper', ['paste.ui.utilities.animation-frame']," +
                    " (m, frames) => { window.afWrapFrames = frames; return m; });"),
                    null),
                (page, evidence) -> {
                    openCheckPage(page, pagePath);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> run = (Map<String, Object>) page.evaluate("async () => {" +
                        " const frames = window.afWrapFrames; const times = []; let inside = true; let early = false;" +
                        " const t0 = performance.now();" +
                        " await new Promise(resolve => {" +
                        "  const step = t => { times.push(t); if (times.length < 12) frames.request(step); else resolve(); };" +
                        "  frames.request(t => { if (inside) early = true; step(t); });" +
                        "  inside = false; setTimeout(resolve, 3000); });" +
                        " return {early, times, t0, now: performance.now(), loaded: !!frames," +
                        "  wrapped: window.requestAnimationFrame !== window.afNative}; }");
                    evidence.putAll(run);
                    active(Boolean.TRUE.equals(run.get("loaded")), "the module defined under the wrapper");
                    active(Boolean.TRUE.equals(run.get("wrapped")), "the page's wrapper replaced requestAnimationFrame");
                    List<?> times = (List<?>) run.get("times");
                    double t0 = ((Number) run.get("t0")).doubleValue();
                    double now = ((Number) run.get("now")).doubleValue();
                    require(!Boolean.TRUE.equals(run.get("early")), "a batch ran inside request()");
                    require(times.size() == 12, "the chained batches stopped after " + times.size() + " of 12");
                    double previous = Double.NEGATIVE_INFINITY;
                    for (Object time : times) {
                        double t = ((Number) time).doubleValue();
                        require(t > previous, "batch times did not strictly increase: " + times);
                        require(t >= t0 - 50 && t <= now + 1, "a batch time is off the performance.now() clock: " + times);
                        previous = t;
                    }
                    double span = ((Number) times.get(times.size() - 1)).doubleValue()
                        - ((Number) times.get(0)).doubleValue();
                    require(span >= 80, "twelve batches spanned " + span + " ms of frame time: the clock froze");
                });
        }
    }

    // A page wrapper that refuses a frame request yet registers the real
    // frame too — one that registers and then throws, and one that calls
    // back at once and also registers — leaves two carriers for one
    // batch. A per-batch loop runs for one second while the page counts
    // real frames. The first carrier to arrive delivers and the other is
    // stale, so batches keep pace with frames: a frame the host delivers
    // later than the 20 ms fallback timer can share its interval with
    // that timer's batch, so a real frame carries at most two batches,
    // the run at most a quarter more batches than frames, and the second
    // half is no busier than the first.
    private static void animationFrameDoubleCarrierRegressions(Browser browser, String engine) {
        String counter = "window.afNative = window.requestAnimationFrame; window.afRealFrames = 0;" +
            " (function tick() { window.afRealFrames += 1; window.afNative.call(window, tick); })();";
        Map<String, String> wrappers = new LinkedHashMap<>();
        wrappers.put("registering-then-throwing", counter + " window.requestAnimationFrame = function (cb) {" +
            " window.afNative.call(window, cb); throw new Error('wrapper failed after registering'); };");
        wrappers.put("synchronous-and-registering", counter + " window.requestAnimationFrame = function (cb) {" +
            " cb(performance.now()); return window.afNative.call(window, cb); };");
        for (Map.Entry<String, String> wrapper : wrappers.entrySet()) {
            String pagePath = "animation-frame-double-carrier-" + wrapper.getKey() + ".html";
            scenario(browser, engine, "animation-frame keeps batches to the pace of real frames under a page's "
                    + wrapper.getKey() + " requestAnimationFrame wrapper", null,
                context -> routeCheckPage(context, pagePath, checkPage("",
                    "<script>" + wrapper.getValue() + "</script>",
                    ANIMATION_FRAME_WRAPPER_SCRIPTS,
                    "paste.define('check.animation-frame-double-carrier', ['paste.ui.utilities.animation-frame']," +
                    " (m, frames) => { window.afWrapFrames = frames; return m; });"),
                    null),
                (page, evidence) -> {
                    openCheckPage(page, pagePath);
                    @SuppressWarnings("unchecked")
                    Map<String, Object> run = (Map<String, Object>) page.evaluate("async () => {" +
                        " const frames = window.afWrapFrames; const per = {}; let batches = 0, maxPer = 0;" +
                        " let stop = false, inside = false, early = false, threw = 0;" +
                        " const sleep = ms => new Promise(r => setTimeout(r, ms));" +
                        " const loop = () => { if (inside) early = true; batches += 1; const f = window.afRealFrames;" +
                        "  per[f] = (per[f] || 0) + 1; if (per[f] > maxPer) maxPer = per[f];" +
                        "  if (!stop && batches < 5000) { inside = true; try { frames.request(loop); } catch (e) { threw += 1; } inside = false; } };" +
                        " const f0 = window.afRealFrames;" +
                        " inside = true; try { frames.request(loop); } catch (e) { threw += 1; } inside = false;" +
                        " await sleep(500); const firstHalf = batches; const fHalf = window.afRealFrames;" +
                        " await sleep(500); stop = true;" +
                        " return {batches, firstHalf, secondHalf: batches - firstHalf, realFrames: window.afRealFrames - f0," +
                        "  firstHalfFrames: fHalf - f0, maxBatchesPerRealFrame: maxPer, early, threw, loaded: !!frames," +
                        "  wrapped: window.requestAnimationFrame !== window.afNative}; }");
                    evidence.putAll(run);
                    active(Boolean.TRUE.equals(run.get("loaded")), "the module defined under the wrapper");
                    active(Boolean.TRUE.equals(run.get("wrapped")), "the page's wrapper replaced requestAnimationFrame");
                    int batches = ((Number) run.get("batches")).intValue();
                    int realFrames = ((Number) run.get("realFrames")).intValue();
                    int firstHalf = ((Number) run.get("firstHalf")).intValue();
                    int secondHalf = ((Number) run.get("secondHalf")).intValue();
                    int maxPer = ((Number) run.get("maxBatchesPerRealFrame")).intValue();
                    active(realFrames >= 20, "the page counted real frames: " + realFrames);
                    require(!Boolean.TRUE.equals(run.get("early")), "a batch ran inside request()");
                    require(((Number) run.get("threw")).intValue() == 0, "request() threw under the wrapper");
                    require(batches >= realFrames / 2, "the loop stalled: " + batches + " batches in " + realFrames + " frames");
                    require(maxPer <= 2, "a real frame carried " + maxPer + " batches");
                    require(batches <= realFrames * 5 / 4 + 2, batches + " batches in " + realFrames + " real frames");
                    require(secondHalf <= firstHalf * 5 / 4 + 5, "batches grew: " + firstHalf + " then " + secondHalf);
                });
        }
    }

    public static void main(String[] args) throws Exception {
        url = args.length > 0 ? args[0] : "http://127.0.0.1:8087/";
        if (!url.endsWith("/")) url += "/";
        require(url.matches("^https?://(127\\.0\\.0\\.1|localhost|\\[::1\\])(:\\d+)?/.*"),
            "the fixture URL must be loopback — browser evidence cannot bind to a remote host: " + url);
        nameFilter = args.length > 2 && !args[2].isBlank() ? args[2] : null;
        output = Path.of(args.length > 1 ? args[1] : "target/browser-checks-elements")
            .toAbsolutePath().normalize();
        if (!output.startsWith(Path.of("").toAbsolutePath())) {
            throw new IllegalArgumentException("the results directory must stay inside the working directory");
        }
        Files.createDirectories(output);
        verifyFixtureIdentity();
        try (Playwright playwright = Playwright.create()) {
            for (String engine : List.of("chromium", "firefox", "webkit")) {
                try { runBrowser(playwright, engine); }
                catch (Throwable error) {
                    RESULTS.add(Map.of("browser", engine, "name", "browser launch/runtime", "passed", false, "failure", error.toString()));
                    System.err.println("FAIL " + engine + " launch/runtime: " + error);
                }
            }
        } finally {
            Files.writeString(output.resolve("results.json"), new GsonBuilder().setPrettyPrinting().create().toJson(RESULTS) + "\n");
        }
        long failed = RESULTS.stream().filter(result -> !Boolean.TRUE.equals(result.get("passed"))).count();
        System.out.println("RESULT " + (RESULTS.size() - failed) + " passed, " + failed + " failed. " +
            "Scenarios selected per browser: " + SELECTED_BY_BROWSER +
            ". Evidence: " + output.resolve("results.json"));
        if (nameFilter != null && SELECTED_BY_BROWSER.values().stream().mapToInt(Integer::intValue).sum() == 0) {
            throw new AssertionError("filter '" + nameFilter + "' matched no declared scenario");
        }
        if (failed != 0) throw new AssertionError(failed + " browser checks failed");
    }
}
