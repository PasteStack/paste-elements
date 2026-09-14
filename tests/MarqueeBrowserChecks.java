import com.google.gson.GsonBuilder;
import com.microsoft.playwright.*;
import com.microsoft.playwright.options.ReducedMotion;
import com.microsoft.playwright.options.WaitUntilState;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Real browser acceptance checks. See run-marquee-browser-checks.sh for the offline runner. */
public final class MarqueeBrowserChecks {
    private static final int[] WIDTHS = {375, 768, 1280, 1920};
    private static final List<Map<String, Object>> RESULTS = new ArrayList<>();
    private static String url;
    private static Path output;

    // Capture at interactive, before the fixture's deferred script executes. No API is replaced.
    private static final String CAPTURE = """
        (() => {
          window.marqueeChecks = {captured: false};
          const capture = () => {
            const h = window.marqueeChecks;
            if (h.captured) return;
            h.roots = Array.from(document.querySelectorAll('[data-paste-marquee]'));
            h.initial = h.roots.map(root => {
              const list = root.querySelector('ul');
              const toggle = root.querySelector('button');
              return {root, list, toggle, items: Array.from(list.children),
                label: list.getAttribute('aria-label'), state: root.getAttribute('data-paste-marquee-state'),
                hidden: toggle.hidden, disabled: toggle.disabled, text: toggle.textContent};
            });
            h.expected = h.initial.map(entry => entry.items.slice());
            h.captured = true;
          };
          document.addEventListener('readystatechange', () => {
            if (document.readyState === 'interactive') capture();
          });
        })()
        """;

    private static final String HELPERS = """
        (() => {
          const h = window.marqueeChecks;
          h.assert = (value, message, details) => {
            if (!value) throw new Error(message + (details === undefined ? '' : ': ' + JSON.stringify(details)));
          };
          h.state = i => h.roots[i].getAttribute('data-paste-marquee-state');
          h.rect = element => {
            const r = element.getBoundingClientRect();
            return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height};
          };
          h.identities = () => {
            const roots = Array.from(document.querySelectorAll('[data-paste-marquee]'));
            h.assert(roots.length === 3, 'exactly three original roots', roots.length);
            h.initial.forEach((original, i) => {
              const root = roots[i], list = original.list, expected = h.expected[i];
              h.assert(root === original.root, 'original root identity ' + i);
              h.assert(root.querySelectorAll('ul').length === 1 && list.parentElement === root,
                'one direct native UL per root ' + i);
              h.assert(root.querySelector('ul') === list, 'original list identity ' + i);
              h.assert(list.getAttribute('aria-label') === original.label && original.label.length > 0,
                'unchanged list accessible label ' + i);
              h.assert(list.getAttribute('role') === 'list', 'list role preserved for WebKit ' + i);
              h.assert(root.querySelector('button') === original.toggle, 'original toggle identity ' + i);
              h.assert(list.children.length === expected.length && root.querySelectorAll('li').length === expected.length,
                'native LI cardinality ' + i, {actual: list.children.length, expected: expected.length});
              expected.forEach((item, j) => {
                h.assert(item === list.children[j] && item.tagName === 'LI' && item.isConnected,
                  'original LI identity/order ' + i + '/' + j);
                h.assert(!item.hidden && item.getAttribute('aria-hidden') !== 'true', 'original not hidden ' + i + '/' + j);
              });
              h.assert(!root.querySelector('[aria-hidden="true"]'), 'no hidden duplicate subtree ' + i);
            });
            return h.expected.map(items => items.length);
          };
          h.bounded = () => {
            const viewport = document.documentElement.clientWidth;
            const boxes = h.roots.map(h.rect);
            boxes.forEach((box, i) => h.assert(box.width > 0 && box.left >= -0.1 && box.right <= viewport + 0.1,
              'root fits horizontal viewport ' + i, {box, viewport}));
            h.assert(document.documentElement.scrollWidth <= viewport + 1,
              'document has no horizontal overflow', {scrollWidth: document.documentElement.scrollWidth, viewport});
            return boxes;
          };
          h.flow = i => {
            h.bounded();
            const {root, list, toggle} = h.initial[i];
            const box = h.rect(list), style = getComputedStyle(list), viewport = document.documentElement.clientWidth;
            h.assert(style.display === 'flex' && style.flexWrap === 'wrap' && style.overflowX === 'visible',
              'normal unclipped wrapping list ' + i, {display: style.display, wrap: style.flexWrap, overflow: style.overflowX});
            h.assert(list.getAnimations({subtree: true}).length === 0, 'no active animations in normal flow ' + i);
            const boxes = h.expected[i].map((item, j) => {
              const r = h.rect(item), s = getComputedStyle(item);
              h.assert(s.position !== 'absolute' && s.transform === 'none' && s.visibility === 'visible' && s.display !== 'none',
                'original is readable in normal flow ' + i + '/' + j, {position: s.position, transform: s.transform});
              h.assert(r.width > 0 && r.height > 0 && r.left >= -0.1 && r.right <= viewport + 0.1,
                'original fits horizontal viewport ' + i + '/' + j, {r, viewport});
              h.assert(r.left >= box.left - 0.1 && r.right <= box.right + 0.1 &&
                r.top >= box.top - 0.1 && r.bottom <= box.bottom + 0.1,
                'whole original lies inside expanded list ' + i + '/' + j, {r, box});
              h.assert(item.scrollWidth <= item.clientWidth + 1 && item.scrollHeight <= item.clientHeight + 1,
                'payload fits its original item ' + i + '/' + j);
              return r;
            });
            boxes.forEach((a, j) => boxes.slice(j + 1).forEach(b => h.assert(
              a.right <= b.left + 0.1 || b.right <= a.left + 0.1 || a.bottom <= b.top + 0.1 || b.bottom <= a.top + 0.1,
              'normal flow items do not overlap ' + i, {a, b})));
            if (h.state(i) !== 'paused') h.assert(toggle.hidden && toggle.disabled,
              'static/no-script pause control stays hidden and disabled ' + i);
            return {state: h.state(i), list: box, items: boxes};
          };
          h.geometry = () => {
            const list = h.initial[0].list, items = h.expected[0];
            const size = items[0].getBoundingClientRect().width;
            const gap = parseFloat(getComputedStyle(list).columnGap);
            const distance = parseFloat(list.style.getPropertyValue('--paste-marquee-distance'));
            h.assert(Math.abs(distance - items.length * (size + gap)) < 0.1,
              'geometry reflects current original cardinality', {distance, size, gap, count: items.length});
            h.assert(distance >= list.clientWidth + size, 'continuous row has enough offscreen coverage');
            return {distance, size, gap, count: items.length, clip: h.rect(list)};
          };
          h.wraps = () => {
            h.assert(h.state(0) === 'running', 'running before wrap inspection');
            h.geometry();
            const list = h.initial[0].list, clip = h.rect(list);
            h.assert(getComputedStyle(list).overflowX === 'hidden', 'active row is clipped');
            const samples = h.expected[0].map((item, i) => {
              const animations = item.getAnimations();
              h.assert(animations.length === 1, 'one CSS animation per original ' + i);
              const animation = animations[0], timing = animation.effect.getTiming();
              h.assert(animation instanceof CSSAnimation && timing.iterations === Infinity && timing.easing === 'linear',
                'native linear infinite CSS animation ' + i);
              const duration = Number(timing.duration), delay = Number(timing.delay);
              h.assert(duration > 0 && delay < 0 && delay > -duration, 'negative stagger delay within cycle ' + i, timing);
              const wrapTime = duration + delay;
              // Geometry only: just before/after this cell's own wrap, not the shared timeline's origin.
              // A 0.001 ms seek epsilon allows at most 0.1 CSS px endpoint rounding, not a visible-cell reset.
              const epsilon = 0.001;
              const previousTime = animation.currentTime;
              animation.pause();
              animation.currentTime = wrapTime - epsilon;
              const before = h.rect(item);
              animation.currentTime = wrapTime + epsilon;
              const after = h.rect(item);
              animation.currentTime = previousTime;
              animation.play();
              h.assert(before.right <= clip.left + 0.1 && before.left < clip.left,
                'pre-wrap original fully outside left clip (0.1px rounding) ' + i, {clip, before, duration, delay, wrapTime});
              h.assert(after.left >= clip.right - 0.1 && after.right > clip.right,
                'post-wrap original fully outside right clip ' + i, {clip, after, duration, delay, wrapTime});
              return {item: i, duration, delay, wrapTime, before, after};
            });
            return {clip, samples};
          };
          h.owned = () => h.initial.map(({root, list, toggle}) => ({
            state: root.getAttribute('data-paste-marquee-state'),
            hidden: toggle.hidden, disabled: toggle.disabled, text: toggle.textContent,
            properties: ['--paste-marquee-distance', '--paste-marquee-item-size', '--paste-marquee-row-height', '--paste-marquee-duration']
              .map(name => [name, list.style.getPropertyValue(name), list.style.getPropertyPriority(name)]),
            delays: Array.from(list.children).map(item => [item.style.getPropertyValue('--paste-marquee-delay'),
              item.style.getPropertyPriority('--paste-marquee-delay')])
          }));
        })()
        """;

    @FunctionalInterface
    private interface Check { void run(Page page, Map<String, Object> evidence); }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static void state(Page page, int index, String expected) {
        page.waitForFunction("arg => marqueeChecks.state(arg.index) === arg.expected",
            Map.of("index", index, "expected", expected));
    }

    private static void identities(Page page) {
        page.evaluate("() => marqueeChecks.identities()");
    }

    private static void setup(Page page, boolean javascript) {
        if (javascript) {
            page.waitForFunction("() => window.marqueeChecks?.captured && marqueeChecks.roots.length === 3 && marqueeChecks.roots.every(r => r.hasAttribute('data-paste-marquee-state'))");
        } else {
            // JavaScript is disabled for page scripts; Playwright's evaluator can still inspect the DOM.
            page.evaluate("window.marqueeChecks = {}");
            page.evaluate("""
                () => {
                  const h = marqueeChecks;
                  h.roots = Array.from(document.querySelectorAll('[data-paste-marquee]'));
                  h.initial = h.roots.map(root => { const list = root.querySelector('ul'), toggle = root.querySelector('button');
                    return {root, list, toggle, items: Array.from(list.children), label: list.getAttribute('aria-label'),
                      state: root.getAttribute('data-paste-marquee-state'), hidden: toggle.hidden, disabled: toggle.disabled, text: toggle.textContent}; });
                  h.expected = h.initial.map(x => x.items.slice());
                }
                """);
        }
        page.evaluate(HELPERS);
        page.evaluate("""
            () => {
              const h = marqueeChecks;
              h.assert(JSON.stringify(h.initial.map(x => x.items.length)) === '[11,1,2]', 'fixture original counts before init');
              h.initial.forEach((x, i) => h.assert(x.state === null && x.hidden && x.disabled,
                'captured original unenhanced DOM before deferred initialization ' + i, {state: x.state, hidden: x.hidden, disabled: x.disabled}));
              h.identities();
            }
            """);
        if (javascript) {
            page.evaluate("""
                () => new Promise(resolve => paste.require(['paste.ui.marquee'], (module, marquee) => {
                  marqueeChecks.module = marquee;
                  marqueeChecks.controls = marqueeChecks.roots.map(root => marquee.init(root));
                  resolve();
                }))
                """);
        }
    }

    private static void scenario(Browser browser, String engine, String name, int width,
                                 boolean javascript, boolean unsupported, boolean reduced, Check check) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("browser", engine);
        result.put("browserVersion", browser.version());
        result.put("executable", engine.equals("chromium") && System.getenv("MARQUEE_CHROMIUM_EXECUTABLE") != null
            ? System.getenv("MARQUEE_CHROMIUM_EXECUTABLE") : "Playwright bundled browser");
        result.put("name", name);
        result.put("width", width);
        List<String> errors = new ArrayList<>();
        Map<String, Object> evidence = new LinkedHashMap<>();
        result.put("evidence", evidence);
        long start = System.nanoTime();
        try (BrowserContext context = browser.newContext(new Browser.NewContextOptions()
                .setViewportSize(width, 1200).setJavaScriptEnabled(javascript)
                .setReducedMotion(reduced ? ReducedMotion.REDUCE : ReducedMotion.NO_PREFERENCE))) {
            if (javascript) context.addInitScript(CAPTURE);
            // The sole capability override is this explicit unsupported-browser test.
            if (unsupported) context.addInitScript("window.ResizeObserver = undefined;");
            Page page = context.newPage();
            page.setDefaultTimeout(6000);
            page.onPageError(errors::add);
            Response response = page.navigate(url, new Page.NavigateOptions().setWaitUntil(WaitUntilState.LOAD));
            require(response != null && response.ok(), "fixture must load successfully");
            setup(page, javascript);
            check.run(page, evidence);
            identities(page);
            page.waitForTimeout(100);
            require(errors.isEmpty(), "uncaught page errors: " + errors);
            result.put("passed", true);
            System.out.println("PASS " + engine + " " + name + " width=" + width);
        } catch (Throwable error) {
            result.put("passed", false);
            result.put("failure", error.toString());
            System.err.println("FAIL " + engine + " " + name + " width=" + width + "\n" + error);
        }
        result.put("pageErrors", errors);
        result.put("elapsedMs", (System.nanoTime() - start) / 1_000_000);
        RESULTS.add(result);
    }

    private static void nativeMotion(Page page, Map<String, Object> evidence, String key, int waitMs) {
        page.evaluate("""
            () => {
              const h = marqueeChecks;
              h.motion = {item: h.expected[0][0], animation: h.expected[0][0].getAnimations()[0]};
              h.assert(h.motion.animation.playState === 'running', 'normal CSS time is running');
              h.motion.startTime = h.motion.animation.currentTime;
              h.motion.transform = getComputedStyle(h.motion.item).transform;
            }
            """);
        page.waitForTimeout(waitMs);
        evidence.put(key, page.evaluate("""
            () => {
              const h = marqueeChecks, m = h.motion;
              const transform = getComputedStyle(m.item).transform, elapsed = m.animation.currentTime - m.startTime;
              h.assert(elapsed > 0, 'native CSS animation timeline advances', elapsed);
              h.assert(transform !== m.transform, 'computed transform advances under normal CSS time', {before: m.transform, after: transform});
              h.assert(m.item.getAnimations()[0] === m.animation && m.animation.playState === 'running', 'same animation keeps running');
              return {elapsed, before: m.transform, after: transform, duration: m.animation.effect.getTiming().duration};
            }
            """));
    }

    private static void runBrowser(Playwright playwright, String engine) {
        BrowserType type = engine.equals("chromium") ? playwright.chromium() : playwright.webkit();
        BrowserType.LaunchOptions launch = new BrowserType.LaunchOptions().setHeadless(true);
        String executable = System.getenv("MARQUEE_CHROMIUM_EXECUTABLE");
        if (engine.equals("chromium") && executable != null && !executable.isBlank()) {
            launch.setExecutablePath(Path.of(executable));
        }
        try (Browser browser = type.launch(launch)) {
            System.out.println("BROWSER " + engine + " " + browser.version());
            for (int width : WIDTHS) {
                scenario(browser, engine, "native semantics, eligibility and offscreen wraps", width, true, false, false, (page, evidence) -> {
                    state(page, 0, "running"); state(page, 1, "static"); state(page, 2, "static");
                    evidence.put("rootBounds", page.evaluate("() => marqueeChecks.bounded()"));
                    evidence.put("short", page.evaluate("() => marqueeChecks.flow(1)"));
                    evidence.put("interactive", page.evaluate("() => marqueeChecks.flow(2)"));
                    page.evaluate("() => marqueeChecks.controls.forEach((control, i) => marqueeChecks.assert(control === marqueeChecks.module.init(marqueeChecks.roots[i]), 'idempotent initialization'))");
                    nativeMotion(page, evidence, "nativeMotion", 180);
                    evidence.put("wraps", page.evaluate("() => marqueeChecks.wraps()"));
                    page.locator("[data-paste-marquee]").nth(2).locator("a").first().focus();
                    state(page, 2, "static");
                    // macOS WebKit uses Option+Tab to include links in native keyboard navigation.
                    page.keyboard().press(engine.equals("webkit") ? "Alt+Tab" : "Tab");
                    require((Boolean) page.evaluate("() => document.activeElement === marqueeChecks.initial[2].list.querySelectorAll('a')[1]"), "native keyboard focus reaches second original link");
                    page.evaluate("() => marqueeChecks.flow(2)");
                });
                scenario(browser, engine, "pause button expands all originals; resume", width, true, false, false, (page, evidence) -> {
                    state(page, 0, "running");
                    Locator button = page.locator("[data-paste-marquee]").first().locator("button");
                    require(button.isVisible() && button.isEnabled() && button.innerText().equals("Pause motion"), "enabled pause control");
                    button.click();
                    state(page, 0, "paused"); identities(page);
                    require(button.innerText().equals("Resume motion"), "pause changes accessible control text");
                    evidence.put("paused", page.evaluate("() => marqueeChecks.flow(0)"));
                    button.click();
                    state(page, 0, "running"); identities(page);
                    nativeMotion(page, evidence, "resumedMotion", 180);
                });
                scenario(browser, engine, "live reduced motion expands originals and restores motion", width, true, false, false, (page, evidence) -> {
                    state(page, 0, "running");
                    page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.REDUCE));
                    state(page, 0, "static"); identities(page);
                    evidence.put("reduced", page.evaluate("() => marqueeChecks.roots.map((root, i) => marqueeChecks.flow(i))"));
                    page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.NO_PREFERENCE));
                    state(page, 0, "running"); identities(page);
                    nativeMotion(page, evidence, "restoredMotion", 180);
                    page.locator("[data-paste-marquee]").first().locator("button").click();
                    state(page, 0, "paused");
                    page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.REDUCE));
                    state(page, 0, "static");
                    page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.NO_PREFERENCE));
                    state(page, 0, "paused");
                    page.evaluate("() => marqueeChecks.flow(0)");
                });
                scenario(browser, engine, "initial reduced motion", width, true, false, true, (page, evidence) -> {
                    state(page, 0, "static");
                    evidence.put("flow", page.evaluate("() => marqueeChecks.roots.map((root, i) => marqueeChecks.flow(i))"));
                });
                scenario(browser, engine, "unsupported ResizeObserver preserves full static list", width, true, true, false, (page, evidence) -> {
                    state(page, 0, "static");
                    page.evaluate("() => marqueeChecks.assert(typeof ResizeObserver === 'undefined', 'unsupported capability installed before init')");
                    evidence.put("flow", page.evaluate("() => marqueeChecks.roots.map((root, i) => marqueeChecks.flow(i))"));
                });
                scenario(browser, engine, "JavaScript disabled leaves all originals readable", width, false, false, false, (page, evidence) -> {
                    require((Boolean) page.evaluate("() => typeof window.paste === 'undefined'"), "production scripts did not execute");
                    page.evaluate("() => marqueeChecks.roots.forEach((root, i) => marqueeChecks.assert(marqueeChecks.state(i) === null, 'no enhancement state with JavaScript disabled'))");
                    evidence.put("flow", page.evaluate("() => marqueeChecks.roots.map((root, i) => marqueeChecks.flow(i))"));
                });
            }
            scenario(browser, engine, "live resize retains originals and refreshes measured geometry", 1280, true, false, false, (page, evidence) -> {
                List<Object> sizes = new ArrayList<>();
                for (int width : WIDTHS) {
                    page.setViewportSize(width, 1200);
                    state(page, 0, "running");
                    page.waitForTimeout(180);
                    identities(page);
                    sizes.add(page.evaluate("() => ({width: innerWidth, roots: marqueeChecks.bounded(), geometry: marqueeChecks.geometry(), wraps: marqueeChecks.wraps()})"));
                    page.locator("[data-paste-marquee]").first().locator("button").click();
                    state(page, 0, "paused"); page.evaluate("() => marqueeChecks.flow(0)"); identities(page);
                    page.locator("[data-paste-marquee]").first().locator("button").click();
                    state(page, 0, "running");
                }
                evidence.put("sizes", sizes);
                // Change actual item dimensions without refresh(), exercising ResizeObserver instead of only viewport reflow.
                page.evaluate("() => marqueeChecks.roots[0].style.setProperty('--paste-marquee-item-width', '10rem')");
                page.waitForFunction("() => Math.abs(parseFloat(marqueeChecks.initial[0].list.style.getPropertyValue('--paste-marquee-item-size')) - marqueeChecks.expected[0][0].getBoundingClientRect().width) < 0.1");
                evidence.put("observedItemResize", page.evaluate("() => marqueeChecks.geometry()"));
            });
            for (boolean important : List.of(false, true)) {
            scenario(browser, engine, "dynamic append/remove and refresh preserve caller nodes" + (important ? " with important delay" : ""), 768, true, false, false, (page, evidence) -> {
                state(page, 0, "running");
                page.evaluate("important => marqueeChecks.important = important", important);
                evidence.put("before", page.evaluate("() => marqueeChecks.geometry()"));
                page.evaluate("""
                    () => {
                      const h = marqueeChecks, item = document.createElement('li');
                      item.className = 'paste-ui-marquee-item'; item.textContent = 'New original';
                      item.style.setProperty('--paste-marquee-delay', '7s', h.important ? 'important' : '');
                      h.appended = item; h.initial[0].list.append(item); h.expected[0].push(item);
                      h.controls[0].refresh(); h.identities();
                    }
                    """);
                state(page, 0, "running");
                evidence.put("appended", page.evaluate("() => ({geometry: marqueeChecks.geometry(), inline: marqueeChecks.appended.style.cssText, computedDelay: getComputedStyle(marqueeChecks.appended).animationDelay, delay: marqueeChecks.appended.getAnimations()[0].effect.getTiming().delay})"));
                evidence.put("appendedWraps", page.evaluate("() => marqueeChecks.wraps()"));
                page.evaluate("""
                    () => {
                      const h = marqueeChecks;
                      h.appended.remove(); h.expected[0].pop(); h.controls[0].refresh(); h.identities();
                      h.assert(h.appended.style.getPropertyValue('--paste-marquee-delay') === '7s' &&
                        h.appended.style.getPropertyPriority('--paste-marquee-delay') === (h.important ? 'important' : ''), 'removed item owned delay restored');
                      h.removed = h.expected[0].splice(1); h.removed.forEach(item => item.remove()); h.controls[0].refresh();
                    }
                    """);
                state(page, 0, "static"); identities(page); page.evaluate("() => marqueeChecks.flow(0)");
                page.evaluate("""
                    () => { const h = marqueeChecks; h.removed.forEach(item => h.initial[0].list.append(item));
                      h.expected[0].push(...h.removed); h.controls[0].refresh(); h.identities(); }
                    """);
                state(page, 0, "running");
                evidence.put("restored", page.evaluate("() => marqueeChecks.geometry()"));
            });
            }
            scenario(browser, engine, "disposal restores owned properties and ignores later events; reinitialize", 768, true, false, false, (page, evidence) -> {
                state(page, 0, "running");
                page.evaluate("""
                    () => {
                      const h = marqueeChecks;
                      h.controls.forEach(control => control.dispose()); h.identities();
                      h.initial.forEach((entry, i) => {
                        h.assert(h.state(i) === entry.state && entry.toggle.hidden === entry.hidden && entry.toggle.disabled === entry.disabled && entry.toggle.textContent === entry.text,
                          'dispose restores original state and toggle ' + i);
                        h.assert(entry.list.style.length === 0 && entry.items.every(item => item.style.length === 0), 'dispose clears owned styles ' + i);
                        h.flow(i);
                      });
                      // Caller-owned values and priorities must survive another complete lifecycle.
                      const list = h.initial[0].list;
                      ['--paste-marquee-distance', '--paste-marquee-item-size', '--paste-marquee-row-height', '--paste-marquee-duration']
                        .forEach((name, i) => list.style.setProperty(name, i === 3 ? '9s' : '9px', 'important'));
                      list.style.setProperty('color', 'rgb(1, 2, 3)');
                      h.expected[0].forEach(item => item.style.setProperty('--paste-marquee-delay', '2s', 'important'));
                      h.roots[0].setAttribute('data-paste-marquee-state', 'caller-state');
                      h.initial[0].toggle.textContent = 'Caller control';
                      h.savedOwned = h.owned();
                      const old = h.controls;
                      h.controls = h.roots.map(root => h.module.init(root));
                      h.controls.forEach((control, i) => h.assert(control !== old[i], 'new controller after disposal ' + i));
                      h.controls.forEach(control => { control.dispose(); control.dispose(); });
                      h.assert(JSON.stringify(h.owned()) === JSON.stringify(h.savedOwned), 'exact owned values and priorities restored');
                      h.assert(list.style.getPropertyValue('color') === 'rgb(1, 2, 3)', 'unowned caller style preserved');
                      h.lateMutations = [];
                      h.watch = new MutationObserver(records => h.lateMutations.push(...records.map(r => r.attributeName)));
                      h.roots.forEach(root => h.watch.observe(root, {subtree: true, attributes: true, childList: true, characterData: true}));
                      h.controls.forEach(control => { control.pause(); control.resume(); control.refresh(); control.dispose(); });
                      h.initial[0].toggle.dispatchEvent(new MouseEvent('click', {bubbles: true}));
                      h.initial[0].list.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
                      h.initial[0].list.dispatchEvent(new FocusEvent('focusout', {bubbles: true}));
                    }
                    """);
                page.setViewportSize(375, 1200);
                page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.REDUCE));
                page.waitForTimeout(180);
                page.emulateMedia(new Page.EmulateMediaOptions().setReducedMotion(ReducedMotion.NO_PREFERENCE));
                page.waitForTimeout(180);
                evidence.put("disposed", page.evaluate("""
                    () => {
                      const h = marqueeChecks;
                      h.assert(h.lateMutations.length === 0, 'no disposed callback mutates DOM after methods/events/resize/media', h.lateMutations);
                      h.assert(JSON.stringify(h.owned()) === JSON.stringify(h.savedOwned), 'disposed styles/state remain restored');
                      h.watch.disconnect(); h.identities(); h.roots.forEach((root, i) => h.flow(i));
                      const result = {owned: h.owned(), lateMutations: h.lateMutations};
                      // Remove the caller's seeded geometry after verifying restoration; test ordinary reinitialization here.
                      // A separate important-geometry scenario exercises motion with those values still present.
                      h.savedOwned[0].properties.forEach(([name]) => h.initial[0].list.style.removeProperty(name));
                      h.expected[0].forEach(item => item.style.removeProperty('--paste-marquee-delay'));
                      h.controls = h.roots.map(root => h.module.init(root));
                      return result;
                    }
                    """));
                state(page, 0, "running"); identities(page);
                page.locator("[data-paste-marquee]").first().locator("button").click();
                state(page, 0, "paused"); page.evaluate("() => marqueeChecks.flow(0)");
                page.locator("[data-paste-marquee]").first().locator("button").click();
                state(page, 0, "running");
                nativeMotion(page, evidence, "reinitializedMotion", 180);
            });
            scenario(browser, engine, "preexisting important geometry is refreshed before motion", 768, true, false, false, (page, evidence) -> {
                page.evaluate("""
                    () => {
                      const h = marqueeChecks; h.controls[0].dispose();
                      h.initial[0].list.style.setProperty('--paste-marquee-distance', '9px', 'important');
                      h.initial[0].list.style.setProperty('--paste-marquee-item-size', '9px', 'important');
                      h.controls[0] = h.module.init(h.roots[0]);
                    }
                    """);
                state(page, 0, "running");
                evidence.put("owned", page.evaluate("() => marqueeChecks.owned()"));
                evidence.put("geometry", page.evaluate("() => marqueeChecks.geometry()"));
                evidence.put("wraps", page.evaluate("() => marqueeChecks.wraps()"));
            });
            scenario(browser, engine, "two shortened cycles advance under native CSS time", 768, true, false, false, (page, evidence) -> {
                page.evaluate("() => { marqueeChecks.roots[0].setAttribute('data-paste-marquee-duration', '0.7'); marqueeChecks.controls[0].refresh(); }");
                state(page, 0, "running");
                nativeMotion(page, evidence, "shortCycles", 1530);
                page.evaluate("() => marqueeChecks.assert(marqueeChecks.motion.animation.currentTime - marqueeChecks.motion.startTime >= 1400, 'observed at least two configured CSS cycles')");
                evidence.put("wraps", page.evaluate("() => marqueeChecks.wraps()"));
            });
        }
    }

    public static void main(String[] args) throws Exception {
        url = args.length > 0 ? args[0] : "http://127.0.0.1:8077/";
        output = Path.of(args.length > 1 ? args[1] : "target/browser-checks");
        Files.createDirectories(output);
        try (Playwright playwright = Playwright.create()) {
            for (String engine : List.of("chromium", "webkit")) {
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
        System.out.println("RESULT " + (RESULTS.size() - failed) + " passed, " + failed + " failed. Evidence: " + output.resolve("results.json"));
        System.out.println("Wrap seeks validate geometry only; native-time observations are not a performance/frame-jitter trace.");
        if (failed != 0) throw new AssertionError(failed + " browser checks failed");
    }
}
