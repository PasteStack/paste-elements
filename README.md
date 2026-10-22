# Paste Elements

**Paste Elements** is the core UI kit for the Paste ecosystem.

YUI-style modules: each element bundles its **JS behavior + SCSS styling** together.
Works standalone for basic HTML sites, or with `paste-surface-*` for templated apps.

## Directory Structure

```
paste-elements/
├── base/                       # Global variables, reset and shared mixins (SCSS only)
│   ├── _variables.scss         # Colors, breakpoints, z-index
│   ├── _base.scss              # Reset/normalize
│   └── _*.scss                 # Media queries, rem, transitions, fallbacks
│
├── modules/                    # UI modules (JS + SCSS together)
│   ├── heroscroll/             # heroscroll.js, heroscroll.scss, _mixin.scss
│   ├── stickynav/              # stickynav.js, stickynav.scss
│   ├── scrollspy/              # scrollspy.js, scrollspy.scss
│   ├── sectionnav/             # sectionnav.scss, _mixin.scss (no JS)
│   ├── autogrow/               # autogrow.js, autogrow.scss, _mixin.scss
│   ├── smoothscroll/           # smoothscroll.js
│   ├── multistate/             # multistate.js, multistate.scss
│   ├── marquee/                # marquee.js, marquee.scss, _mixin.scss
│   ├── form/                   # form.js
│   ├── io-reply-fragment-envelope/
│   ├── scrollscrub/            # Scroll progress custom property
│   ├── imagesequence/          # Scroll-driven frame catalog host (+ SCSS)
│   ├── progressiveresolution/  # Resolution upgrades under CSS policy
│   └── utilities/              # paste.ui.utilities.* (JS only)
│       ├── animation-frame/    # Owned animation-frame batching
│       ├── throttle/           # Event throttling
│       ├── scrollrange/        # Declared range measurement
│       ├── imageresolution/    # Representation ladder selection
│       └── mediaquery/         # Media query observation
│
├── structure/                  # Page structure (SCSS only)
│   ├── grid/                   # grid.scss, _variables.scss
│   ├── layout/                 # layout.scss, _variables.scss
│   ├── typography/             # typography.scss, _variables.scss
│   └── spacing/                # spacing.scss, _variables.scss
│
├── tests/                      # Development only — not part of the package
│   ├── *.test.cjs              # node:test contract suites
│   ├── fakes.cjs               # Shared DOM/runtime fake for the suites
│   ├── vendor/                 # JSLint, used by the lint gates (see NOTICE.md)
│   ├── serve-examples.cjs      # Loopback fixture host for examples/
│   └── run-*-browser-checks.sh # Playwright Java runners (no downloads)
│
└── examples/                   # Development only — not part of the package
    ├── index.html              # Lists the pages the fixture host serves
    ├── reading.html            # scrollscrub progress property
    ├── sequence-hero.html      # imagesequence intro + range, scrollscrub, resolution
    ├── avatars.html            # progressiveresolution under an authored cap
    ├── heroscroll.html         # heroscroll parallax and image fade
    ├── stickynav.html          # stickynav body class and CSS-owned stuck state
    ├── marquee.html            # Built by tests/build-marquee-example.cjs
    ├── sectionnav.html         # Built by tests/build-sectionnav-example.cjs
    └── *.conf                  # Hand-authored inputs to those example builds
```

The published package is source only: `base/`, `modules/`, `structure/`,
`README.md`, `LICENSE`, `NOTICE.md` and `VERSION`. Tests, the vendored test
tooling and the examples stay in the repository; `.gitattributes` marks
`tests/` and `examples/` `export-ignore`, so source archives built from a tag
leave them out too.

## Usage

### Getting the sources

There is no npm package. The modules reach a site in one of two ways:

- **WebJar** (JVM applications): the `com.pastestack:paste-elements-webjar`
  Maven artifact, whose version equals the paste-elements release it wraps,
  carries this repository's published tree under
  `META-INF/resources/webjars/paste-elements-webjar/<version>/` (`base/`,
  `modules/`, `structure/`). See the `paste-elements-webjar` repository for
  the registry and coordinates.
- **Source archive or checkout**: a release tag's source archive (or a
  checkout of the tag), extracted beside the site. paste-assetgraph reads it
  through `include-paths`, together with the core `paste` modules' `src/js`
  directory, which feeds both the SCSS load path and JS module discovery:

  ```hocon
  include-paths = ["<paste-elements checkout>", "<paste checkout>/src/js"]
  ```

### Basic HTML Site (no surface)

**main.scss** (with `paste-elements` on the include path):
```scss
// Override !default variables BEFORE importing the files that read them
$paste-grid-columns: 16;

// Import just what you need
@import 'base/variables';
@import 'structure/grid/grid';

// heroscroll's styles come from its mixin; pass the arguments you need
// ($height, $content-width, $content-padding-x) instead of importing
// heroscroll.scss, which includes the mixin with its defaults
@import 'modules/heroscroll/mixin';
@include paste-ui-heroscroll($height: 80vh);
```

**index.html:**
```html
<section class="paste-ui-hero">
  <div class="paste-ui-hero-image" data-hero-image-fade></div>
  <div class="paste-ui-hero-content">
    <h1>Welcome</h1>
  </div>
</section>

<script src="/paste/site-1/paste.ui.heroscroll~paste.ui.smoothscroll.min.js" defer></script>
```

The script is a JAM combo URL served through paste-assetgraph: the first path
segment is the group's cache key (`site-1` here), then the `~`-separated full
module names — `paste.ui.heroscroll`, never a short name such as `heroscroll`.

### With paste-assetgraph

```bash
paste-assetgraph build
```

Processes all JS/SCSS, generates versioned output and manifest.

## Modules

| Module | JS | SCSS | Description |
|--------|:--:|:----:|-------------|
| heroscroll | ✓ | ✓ | Parallax hero sections |
| stickynav | ✓ | ✓ | Sticky navigation bar |
| scrollspy | ✓ | ✓ | Marks a nav item active as its section scrolls into view |
| sectionnav | - | ✓ | In-page section navigation styling |
| autogrow | ✓ | ✓ | Auto-resize textareas |
| smoothscroll | ✓ | - | Keyboard focus for native in-page fragment links |
| multistate | ✓ | ✓ | Hash-driven UI state (`#key:value`) for tabs and radio inputs |
| marquee | ✓ | ✓ | One semantic list with optional CSS-driven continuous motion |
| throttle | ✓ | - | Event throttling utility (`paste.ui.utilities.throttle`) |
| animation-frame | ✓ | - | Batches DOM writes into the next animation frame (`paste.ui.utilities.animation-frame`) |
| form | ✓ | - | Background submit of `form[data-paste-form]` inside an IO reply fragment target (`paste.ui.form`) |
| io-reply-fragment-envelope | ✓ | - | Applies IO reply fragment envelopes to named targets and bound attributes (`paste.ui.io-reply-fragment-envelope`) |
| scrollscrub | ✓ | - | Publishes a declared scroll range's progress as a CSS custom property (`paste.ui.scrollscrub`) |
| imagesequence | ✓ | ✓ | Scroll- and intro-driven frame catalog on an image or background host (`paste.ui.imagesequence`) |
| progressiveresolution | ✓ | - | Sharper image representations under a CSS cap (`paste.ui.progressiveresolution`) |
| scrollrange | ✓ | - | Declared range measurement utility (`paste.ui.utilities.scrollrange`) |
| imageresolution | ✓ | - | Representation ladder selection and shared image-host helpers utility (`paste.ui.utilities.imageresolution`) |
| mediaquery | ✓ | - | Shared media-query observation (reduced motion, pixel ratio) utility (`paste.ui.utilities.mediaquery`) |

## Marquee

`paste.ui.marquee` enhances one semantic list with optional continuous CSS motion. Each original
item exists once: no clones, reordering, per-frame animation loop, or dependency on Surface. Load its
SCSS/CSS and JavaScript through paste-assetgraph, or use the standalone example. It requires
`paste.event`, `paste.ui.utilities.animation-frame` and `paste.ui.utilities.mediaquery`.

```html
<div class="paste-ui-marquee" data-paste-marquee data-paste-marquee-duration="45">
  <ul class="paste-ui-marquee-items" role="list" aria-label="Partners">
    <li class="paste-ui-marquee-item">Atlas</li>
    <li class="paste-ui-marquee-item">Birch</li>
  </ul>
  <button class="paste-ui-marquee-toggle" type="button" hidden disabled>Pause motion</button>
</div>
```

The short list above intentionally stays static on a wide viewport. Motion requires at least two
noninteractive, equal-width cells and enough content for a completely off-screen reset:
`itemCount * (itemWidth + gap) >= viewportWidth + itemWidth`. CSS phases each original across that
cycle; the Element measures at bind, on resize, on changes to its own list's children, when the toggle
is used, when focus enters or leaves the list, and when the reduced-motion preference changes — never
per animation frame. The bind, resize and child-list refreshes run in the next shared
`paste.ui.utilities.animation-frame` batch, reading geometry in its read phase and writing in its
write phase, so a burst of notifications is one measurement; toggle, focus and preference refreshes
answer at once. The duration (`data-paste-marquee-duration`, default 45) is seconds per cycle, not a
refresh-rate-dependent pixel step, and is re-read on each of those refreshes. It must be a plain
decimal greater than zero — digits with an optional fraction (`4`, `4.5`, `.5`, `4.`), read
untrimmed; a hexadecimal, binary, exponent, signed, empty or space-padded value keeps the list
static.

SCSS entry: `modules/marquee/marquee.scss`; the corresponding mixin is `paste-ui-marquee`.
CSS custom properties `--paste-marquee-item-width`, `--paste-marquee-item-height`, and
`--paste-marquee-gap` control the cell theme. Do not override the item's measured layout with
per-item margins, transforms, or mixed widths. Images need intrinsic dimensions or explicit sizes.
Supply each item's accessible name once. No IDs or site-specific payload model are required.

Missing JavaScript/CSS capabilities, reduced motion, insufficient coverage, or interactive content
leave a readable wrapping list. Focus inside the list does the same for as long as it stays there,
then eligibility is re-evaluated — a focus visit never turns into a pause the reader did not ask
for. Pause also restores the full list; Resume starts a fresh cycle.
The toggle is hidden until functional. Optional `data-paste-marquee-pause-label` and
`data-paste-marquee-resume-label` localize its action labels. Do not use this version to move links,
form controls, or other focusable content; it deliberately keeps those in normal flow.

There is no imperative surface: `data-paste-marquee` binds at module evaluation and the authored
toggle is the only pause control. Dynamic list items are measured through a MutationObserver scoped
to the list's own children; element bindings live as long as the page does. Paste loads at the end
of the document, after the markup it enhances, so roots with `data-paste-marquee` present when the
module runs activate immediately. No global prototype is patched.

Standalone development checks (Node's built-in test runner; no npm dependencies):

```sh
PASTE_CORE_JS=/path/to/paste/src/js node --test 'tests/*.test.cjs'
PASTE_CORE_JS=/path/to/paste/src/js node tests/build-marquee-example.cjs /path/to/paste-assetgraph
python3 -m http.server 8077 --bind 127.0.0.1 --directory target/marquee-example
```

The example build merges `examples/marquee.conf` with the core module location from
`PASTE_CORE_JS` (the `src/js` directory of a `paste` release or checkout) into
`target/marquee-example.conf` (with `include-paths` naming that core directory and this repository's
`modules/utilities`), then emits a self-contained static page with compiled CSS/JS. It
fails with that instruction when the variable is unset rather than guessing a path. The build also
writes `target/marquee-example/build-identity.json`: the SHA-256 of every source it read (the example
page and config, `modules/marquee`, `modules/utilities` and the core files) and of each file the
example serves (`index.html`, `example.js`, `example.css`). Serve the
result with any static server; Scala, Surface, and a JAM server are not required. Missing required
compiled modules fail the example build rather than yielding an unstyled demo. Browser checks
must verify off-screen cycle endpoints, pause/resume, live reduced-motion changes, no-JS behavior,
resize coverage, and unchanged original-node identity. These checks do not by themselves establish
smooth physical display presentation; retain browser-specific profiling for reported jitter.

The real-browser runner reuses an existing Playwright Java 1.41 runtime (playwright, driver,
driver-bundle, and gson jars) and installed Chromium/Firefox/WebKit browsers; it downloads nothing:

```sh
PASTE_CORE_JS=/path/to/paste/src/js \
    PLAYWRIGHT_JAVA_CLASSPATH="$EXISTING_PLAYWRIGHT_CLASSPATH" tests/run-marquee-browser-checks.sh
```

The runner requires `PASTE_CORE_JS`, naming the same core directory the build read. Before any
browser launches it runs `tests/build-marquee-example.cjs --verify`, which fails the run when the
sources no longer hash to the recorded tree (a stale build) or when the server answers with bytes
other than the recorded build's, and it accepts only a loopback `http` URL; that record lands in `target/browser-checks/marquee-identity.json`.
`MARQUEE_URL` defaults to the example server above. `PLAYWRIGHT_BROWSERS_PATH` selects an installed
cache; `MARQUEE_CHROMIUM_EXECUTABLE` optionally selects an installed Chromium-family executable.
The actual browser version, check results, and geometry evidence are written under
`target/browser-checks/`. A missing browser is an error, not a skipped pass.

## Section Navigation

`modules/sectionnav` styles an in-page section nav. The plain markup is a
`paste-ui-section-nav` list of fragment links; adding
`paste-ui-section-nav-disclosure` opts into CSS-only progressive disclosure on
narrow viewports. Disclosure state is the URL fragment: the panel carries the
nav's target id, the open control links to `#<panelId>`, and the close control
links back to the open link's own `#<panelId>-toggle` id. Both controls are
ordinary links — Enter activates them; there is no button and no Space
handler. The module ships no JavaScript and needs none.

```html
<nav class="paste-ui-section-nav paste-ui-section-nav-disclosure" aria-label="Sections">
  <div id="site-sections" class="paste-ui-section-nav-panel" tabindex="-1">
    <ul class="paste-ui-section-nav-items">
      <li class="paste-ui-section-nav-item"><a href="#first">First section</a></li>
    </ul>
  </div>
  <a id="site-sections-toggle" class="paste-ui-section-nav-toggle paste-ui-section-nav-open"
     href="#site-sections" aria-controls="site-sections">Menu</a>
  <a class="paste-ui-section-nav-toggle paste-ui-section-nav-close"
     href="#site-sections-toggle" aria-controls="site-sections">Close menu</a>
</nav>
```

Every open, close, and section selection is real fragment navigation: each
appears in history and Back/Forward traverse them. Selecting a section both
navigates and closes the panel, because the panel is no longer the target.
There is no automatic Escape or click-outside dismissal — the explicit close
link, or any other fragment navigation, closes the panel. Widening past the
breakpoint shows the ordinary list and releases the scroll lock regardless of
the hash; narrowing again reopens the panel while the URL still targets it,
which is intentional rather than a state reset. The optional scroll lock is
the mixin's `html:has(.paste-ui-section-nav-panel:target) { overflow: hidden }`
rule — the only `:has()` use — and degrades to an unlocked menu where `:has()`
is unsupported. Click handlers must not intercept these anchors;
`paste.ui.smoothscroll` never prevents a click and gives links inside
`paste-ui-section-nav-disclosure` no focus handling, so the browser owns
disclosure navigation.

Fragment targets clear the nav. The mixin emits a zero-specificity
`:where(:target, .paste-ui-hero-destination) { scroll-margin-top:
var(--paste-ui-section-nav-clearance, <auto>) }` rule, where `auto` is the
nav's own box: `$height` plus the first width in `$border-bottom` (51px with
the defaults). The browser reads it when it scrolls to a fragment — a link, or
a page loaded with a fragment — so a target lands at the bottom of a fixed or
sticky section nav instead of under it. The second selector covers the hero
without an id that a `data-hero-hashclick` click last scrolled to: it is no
target, so `paste.ui.heroscroll` marks it `paste-ui-hero-destination` until the
next hash click. Back and Forward restore each entry's own scroll position. Any
`scroll-margin-top` rule the page writes for its targets wins over the default.
When more fixed chrome sits above the targets, such as a site header the nav
sticks beneath, set the custom property to the total:

```css
:root { --paste-ui-section-nav-clearance: calc(3.5rem + 51px); }
```

The browser adds a target's `scroll-margin-top` to the scroller's
`scroll-padding-top`. A page that already clears its chrome with
`scroll-padding-top` switches the default off, or the clearance counts twice:

```css
html { scroll-padding-top: 6.5rem; }
:root { --paste-ui-section-nav-clearance: 0px; }
```

`scroll-margin-top` also grows an element's scroll-snap area. On a page that
snaps, the current target and the marked hero may rest the clearance lower than
their neighbours, and one whose area outgrows the viewport no longer snaps
firmly; other heroes are untouched. Such a page clears its chrome with
`scroll-padding-top` on the snapping scroller, which moves every snap position
alike, and zeroes the custom property as above.

Pass `$target-clearance: null` to leave targets to the page, or a length to
replace `auto`. Motion is not part of the default; see the smoothscroll
migration note for `scroll-behavior` and reduced motion.

Build and serve the runnable example:

```sh
node tests/build-sectionnav-example.cjs /path/to/paste-assetgraph
python3 -m http.server 8078 --bind 127.0.0.1 --directory target/sectionnav-example
```

## Form

`paste.ui.form` submits a `form[data-paste-form]` that sits inside an
IO reply fragment target in the background and swaps the returned markup
into that target — the same request the browser would have sent, so the
form works identically without JavaScript.

```html
<div class="paste-ui-io-reply-fragment-target" data-paste-io-reply-fragment-target="feedback">
  <form class="paste-ui-form" action="/feedback" method="post"
        enctype="application/x-www-form-urlencoded" accept-charset="utf-8"
        data-paste-form>
    <!-- fields -->
  </form>
</div>
```

On submit the Element reads the submission the way the browser does: the
submitting button's `formaction`, `formmethod`, `formenctype` and `formtarget`
override the form's `action`, `method`, `enctype` and `target`; without either
target the document's `<base target>` applies. A nonempty action resolves
against the document's base URL, and an empty one is the document's URL. It
then finds the nearest `[data-paste-io-reply-fragment-target]` ancestor and
sends the form's fields and the submitting button's `name`/`value` in
document order, as the browser does, through `paste.io` — URL-encoded,
multipart, or as a query string for `method="get"`,
matching the resolved enctype; a `get` submit replaces any query already in
the action, as the browser would. URL-encoded bodies and query strings are
UTF-8, and multipart bodies pass the `FormData` through for the client to
encode, also as UTF-8; line breaks in field names and string values are sent
as CRLF, as a native submit normalizes them, and a file field contributes its
file name. A native submit picks the first `accept-charset` label the
browser recognises, else the document's encoding, and sends UTF-16 as
UTF-8; a form whose submit would go out in anything but UTF-8
(`accept-charset="ISO-8859-1"`, or a `Shift_JIS` page) submits normally,
while `accept-charset="utf-16"` or a UTF-16 page is still sent in the
background. Where engines disagree the form submits normally: a comma
separates labels in some engines, so both readings must name UTF-8, and a
label of the replacement encoding (`iso-2022-kr` and its aliases) followed
by another is skipped, so the later label decides. Only `get` and `post`
submissions are intercepted, and only when the resolved action is
same-origin — only same-origin markup is ever placed in the page. A target answers one
submission at a time: it is `aria-busy` for the duration, and while a request
is in flight further submits from any form inside it — or inside a target
around it or within it, whose reply would replace it or be replaced by it —
are ignored, so the reply that lands is always the pending request's. The
request carries a deadline — `data-paste-form-timeout` in decimal
milliseconds on the form, default 30000; positive integers through
4294967295 are honored and the literal `0` opts out, while blank, fractional,
signed, scientific-notation, hexadecimal or overflowing input falls back to
the default rather than disabling the deadline silently. The deadline runs
on the module's own timer, which aborts the request and reports it as a
`"timeout"` (an engine may ignore an XHR timeout assigned after the request
is sent); a value past the longest delay a timer holds, about 24.8 days, runs
at that limit. A stalled request cannot hold the busy state forever.

An HTML response of any status whose final URL, after any redirect, is on the
page's origin replaces the target's content, enhances forms inside it, and
focuses the first `[role="alert"]` or `[role="status"]`. Every other outcome
after transmission — a network error, timeout or abort, or a response the
form cannot place (a non-HTML reply, or an HTML reply whose final URL left
the page's origin) — follows one rule: the busy state clears, then the form
dispatches `paste.ui.form:failed`, a bubbling, cancelable event whose
`detail.reason` is `"error"`, `"timeout"`, `"abort"` or `"response"`. A
listener that calls `preventDefault()` owns the failure UX; otherwise the form
resubmits natively only where a replay cannot duplicate the submission — a
`get`, or a form carrying `data-paste-form-idempotent`, which declares that
the endpoint itself collapses replays (an idempotency key or equivalent;
the attribute alone provides no protection). Any other failure appends and
focuses a `paste-ui-form-failure` `role="alert"` notice inside the form —
"may have been received, check before submitting again" — preserving every
entered value. Leaving the page mid-submit is the visitor's choice: an engine
may abort the request as the navigation starts, or fail it as a network
error, so an `"abort"` or `"error"` after `beforeunload` or `pagehide` is
never replayed — a replay would take the visitor to the form's answer instead
of where they went. It still dispatches the event, and gets the default
notice when unhandled, which also covers a navigation that ends without
leaving (a download or a 204). A `beforeunload` the visitor answers by
staying on the page counts for half a second after the page's tasks resume
(timers wait while the prompt is open); with no `pagehide` by then, a later
failure keeps its replay rule. The deadline's own abort is always a
`"timeout"` and keeps its replay. A request that could
not be transmitted at all is the single exception: it submits natively
unconditionally, because nothing was sent.
An
already default-prevented submit, a form without an IO reply fragment target,
a browser that does not report the submitting
button (`SubmitEvent.submitter`), a browser whose `FormData` does not take
the submitting button (`new FormData(form, submitter)`), an image submit
button, a `post` encoded as `text/plain`, a target naming a browsing context
other than `_self`, a form whose submit would not go out as UTF-8 (or that declares
`accept-charset` in a browser without `TextDecoder` to resolve it), or a
browser missing `WeakMap`, `XMLHttpRequest`,
`XMLHttpRequest.responseURL`, `FormData`, `URLSearchParams`, or `URL` submits
normally — nothing is intercepted.

Paste loads at the end of the document, after the markup it enhances, so forms
present when the module runs are enhanced immediately, and forms inside a
swapped-in IO reply fragment are enhanced as they are placed. Each form is
enhanced once; the module exposes no public API.

## IO Reply Fragment Envelope

`paste.ui.io-reply-fragment-envelope` applies an IO reply fragment envelope — a
JSON reply for updating named targets outside a form submit, such as autosave
or paging a list.

```html
<div class="paste-ui-io-reply-fragment-target" data-paste-io-reply-fragment-target="results"><!-- markup --></div>
<span data-paste-io-reply-fragment-bind="data-state=status"></span>
```

`paste.ui.io-reply-fragment-envelope.apply(envelope, status, root)` applies an
envelope only when `status` and `envelope.meta.code` are both `200`. Each
`data.fragments[name].markup` replaces the content of every
`[data-paste-io-reply-fragment-target="name"]` inside `root` (default: the
document) as that name is applied — a target an earlier fragment's markup
placed is found, one it detached is not. Names with no matching target are
skipped and `js`/`css` lists are ignored — the Element does not load them.
It places markup only: Elements inside the placed markup, `paste.ui.form`
included, are not enhanced. Each element carrying
`data-paste-io-reply-fragment-bind="attribute=variable, ..."` has `attribute`
set to `data.variables[variable]` for every variable present in the envelope
as a string; any other value is ignored. It returns the number of target
elements replaced, or `0` when nothing was applied.

## Structure

| Module | Description | Key Variables |
|--------|-------------|---------------|
| grid | 12-column responsive grid | `$paste-grid-columns`, `$paste-grid-gutter` |
| layout | Page structure (header, footer) | `$paste-header-height`, `$paste-footer-padding-y` |
| typography | Headings, paragraphs, links | `$paste-font-family-*`, `$paste-font-size-*` |
| spacing | Margin/padding utilities | `$paste-spacers`, `$paste-section-padding-y` |

## Declarative scroll and image modules

`paste.ui.scrollscrub`, `paste.ui.imagesequence` and
`paste.ui.progressiveresolution`, with the shared utilities
`paste.ui.utilities.scrollrange`, `paste.ui.utilities.imageresolution` and
`paste.ui.utilities.mediaquery`, are new: none of them was part of a release up
to 0.5.0. They are declarative enhancements — authored `data-*` markup, a
baseline that works without JavaScript, CSS-owned presentation. Each binds the
declarations present when it is defined; there is no controller, event or
readiness surface to wire. Each module's header documents its full contract,
and contract suites and real-browser checks pin the behaviour.

| Module | Requires |
| --- | --- |
| `paste.ui.scrollscrub` | `paste.event`, `paste.ui.utilities.animation-frame`, `paste.ui.utilities.scrollrange` |
| `paste.ui.imagesequence` | `paste.event`, `paste.ui.utilities.animation-frame`, `paste.ui.utilities.scrollrange`, `paste.ui.utilities.imageresolution`, `paste.ui.utilities.mediaquery` |
| `paste.ui.progressiveresolution` | `paste.event`, `paste.ui.utilities.animation-frame`, `paste.ui.utilities.imageresolution`, `paste.ui.utilities.mediaquery` |
| `paste.ui.utilities.imageresolution` | `paste.event` |
| `paste.ui.utilities.scrollrange`, `.mediaquery` | nothing |

**scrollscrub.** `data-paste-scrollscrub` on a scope element publishes the
scope's progress through a declared scroll range as `--paste-scrub-progress`,
a number from 0 to 1 on that element; what the value does is the page's CSS.
`data-scrub-mode` (`element`, the default, or `container` for the root's own
scroll fraction), `data-scrub-root` (`viewport`, the default, or a selector for
exactly one scrolling element — one naming the document's own scroller is the
viewport), `data-scrub-subject` (inside an element root, never the root
itself — a scope that is its own root is an invalid declaration),
`data-scrub-start`/`data-scrub-end` (anchor
pairs such as `top bottom`; each anchor is `top`, `center` or `bottom`) and
`data-scrub-window` (two fractions `a b`, 0 ≤ a < b ≤ 1) declare the range. A
range that cannot measure — anchors that coincide, an element root that cannot
scroll (a body root among them while the viewport takes the body's overflow
over), an unrendered subject or root — removes the property, so the authored
`var()` fallback stands. Measuring runs in the shared animation-frame batch: a
root's own scroll re-reads only its offset, while a resize, an observed box or
content growing — the root's content, or the boxes on an element-mode
subject's own path, so content changing inside a fixed-height wrapper counts —
and a return to a visible page re-measure. The page's scroll moves a nested
root and its subjects together and re-measures nothing.

**imagesequence.** `data-paste-imagesequence="#catalog"` on an `img` or on a
background host names a `script[type="application/json"]` frame catalog,
`{"frames": [{"src", "width", "height", "upgrades"}, ...]}`. The scroll range of
a scrollscrub declaration — the one `data-sequence-scrub` names (exactly one
element carrying `data-paste-scrollscrub`), else the nearest such
ancestor-or-self — maps onto the catalog indices `data-sequence-from` to
`data-sequence-to`, which may run in reverse. The sequence measures that
declaration through scrollrange, so scrollscrub itself need not be loaded. It
re-measures as the page scrolls or resizes, when an observed box changes size
and on a return to a visible page, and, when it binds before the document's
`load`, once more when that fires, as scrollscrub does: an image or font that
lands late inside a fixed-size box moves the subject without resizing anything
watched, and the scope and its sequence still agree.
`data-sequence-intro-*` declares one finite intro (duration, range, startup
buffer, the `ready` trigger, `ease-in-out` or `linear` easing, and an optional
skip control, which must be an authored `type="button"` carrying `hidden`).
Without `data-sequence-intro-skip` the intro has no skip control and still ends
on any scroll, a hidden document, reduced motion, a failure, or completion;
`data-sequence-scrub-buffer-frames` holds a frame change until that many frames
in the direction of travel are ready. The authored image is the baseline: it
stays until a wanted frame is ready, and it is the whole presentation without
the module, when loads fail, and under reduced motion (a preference the
platform cannot report counts as reduced). A declared intro never replays on a
back/forward return: a per-scene `sessionStorage` record, written when its clock
starts, sends that return straight to scroll ownership. An ordinary load or
reload plays it again.

`data-paste-progressiveresolution` on a sequence host permits sharper
representations of the displayed frame under the same CSS cap as
progressiveresolution. On an `img` host a frame's base paints as `src`, and a
sharper representation is always written as a module-owned `srcset` width
descriptor plus a `sizes` equal to the frame's intrinsic width, so the box
never grows with the pixels, whatever the CSS sizing; the pair comes off before
the next base paint and under reduced motion, each attribute only while it
still holds the module's own value.
An `img` with an authored `srcset` or `sizes`, or inside `<picture>`, is left
to the browser without a report.

A background frame paint stands once the computed `background-image` shows it.
While a background-image transition is in flight — as `getAnimations()` lists
it, or, where the platform cannot list animations, for a bounded time under a
declared transition — the paint is pending and sharpening waits for it to
settle; any other value, such as an `!important` stylesheet rule outranking the
frame, reverts the paint at once. A poster restored under reduced motion
through such a transition is adopted when the transition ends, so a declared
initial frame zero still sharpens. A frame whose decoded pixels contradict its
catalog entry (another width, or an aspect ratio more than 1% off) fails for
the page's life, like a load error; a vector source (a `.svg` or `.svgz` path,
or an `image/svg+xml` data URL) is exempt, because the size an engine reports
for it is not a pixel size.

The optional stylesheet `modules/imagesequence/imagesequence.scss` — stylesheet
module `paste.ui.imagesequence.style`, mixin `paste-ui-imagesequence` in
`modules/imagesequence/_mixin.scss` — gives a non-`img`
`[data-paste-imagesequence]` host `display: block` and a centred, covering,
non-repeating background. The rule sits in `:where()`, at zero specificity, so
the page's own CSS always wins; an `img` host and the skip control get nothing.

**progressiveresolution.** `data-paste-progressiveresolution` with
`data-image-sources="#descriptor"` — a `script[type="application/json"]`
holding `{"src", "width", "height", "upgrades"}`, whose base describes the
authored image and whose upgrades grow in both width and height and keep its
aspect ratio — upgrades one image to the smallest representation that covers
its painted need (the painted box times the device pixel ratio, honest about
`object-fit` and `background-size`; the box is an `img`'s content box inside
its padding and border, and a background's positioning area: its
`background-origin` box, the padding box by default, measured over the whole
scrollable content for `background-attachment: local` on a box whose overflow
scrolls, or the larger of the viewport and that box for
`background-attachment: fixed`) inside the cap `--paste-resolution-max-width`
(a unitless intrinsic pixel width; `auto`, the default, means no cap). It
commits only a representation sharper than the one displayed, so a lowered cap
or a shrunken box never makes the image worse.

- An `img` host upgrades through a module-owned width-descriptor `srcset` plus a
  `sizes` equal to the base width; the authored `src` is never rewritten. Read
  `currentSrc`, not `src`, to see the displayed rung. An `img` with an authored
  `srcset` or `sizes`, or inside `<picture>`, is left to the browser.
- A background whose `background-size` paints the image at its own intrinsic
  size (`auto`) never asks for an upgrade: a larger source would paint larger,
  not sharper.
- An `img` authored `loading="lazy"` fetches no upgrade until it comes within
  about one viewport of the top-level viewport. Where the browser has
  `IntersectionObserver`, its report decides, so a slide a carousel clips or
  an image in a frame far down the page stays deferred; without it, the box is
  checked against its own window's viewport on both axes as the page or an
  ancestor scrolls. An image in a frame gets less margin: a cross-origin frame
  gets none, so the upgrade waits until the image is visible, and a browser
  that pauses an off-screen frame's animation frames upgrades once the frame is
  on screen.
- A `background-attachment: fixed` background is sized for the larger of the
  viewport and its `background-origin` box in each dimension. A browser may
  paint it as `scroll` instead (a transform on the host or an ancestor, or a
  browser that ignores `fixed`, such as iOS Safari), and the module cannot tell
  which it did, so it fetches more than the painted box needs, never less. In
  quirks mode the viewport is the window's inner size, which on a zoomed-out
  mobile visual viewport can exceed the layout viewport: more than needed
  again. A `local` background on a box overflow does not apply to, such as an
  inline element, is sized by its `background-origin` box. Firefox paints a
  `local` background on a scrolling table cell by the cell's own box, while
  the module sizes it by the scrollable content: more than needed, never
  less.
- When another script writes an `img` host's `src`, `srcset` or `sizes`, the
  module stands down and removes the `srcset` and `sizes` it wrote, each only
  while it still holds the module's own value, so the other writer's choice
  displays. A background host stands down when its computed
  `background-image` is no longer the module's upgrade (while a
  background-image transition runs, a cross-fade that still includes it, or
  for a bounded time the image it replaced, is not a foreign write).
- `crossorigin` and `referrerpolicy` carry over to the upgrade fetch from `img`
  hosts only.
- A decode refused while the page is hidden is retried once by the first pass
  after it is visible again, if that pass still selects the URL; a URL that
  pass does not select is released, and a later selection is a fresh attempt.
  A refusal of that retry, a refusal while visible, a load error, or a decoded
  image whose size contradicts its descriptor is final for that URL. A vector
  source is never held to its decoded size, which is the browser's own
  default. A decoded image does not report its media type, so only the URL
  marks a vector source: a path ending `.svg` or `.svgz` (before any query or
  fragment), or an `image/svg+xml` data URL. An SVG served at another URL is
  held to its declared size, and a raster served at such a path is not.
  Upgrades never wait for the page's `load` event.

**Utilities.** `scrollrange` reads and measures a scrub declaration (`read`,
`measure(range)`, `progressFrom`, plus `scrollOffset` and `contentOf` for its
owners), `imageresolution` validates descriptors and picks a representation
(pure functions, no DOM) and holds the host reads and the image preparation
imagesequence and progressiveresolution share, and `mediaquery` holds the one
`matchMedia` binding the elements share (`observe`, `motionReduced`,
`watchResolution`). They are internal to the elements: a page loads them
because an element requires them, and none reads markup of its own.

**Malformed declarations.** `imagesequence`, `progressiveresolution` and
`scrollscrub` leave a host whose declaration they reject at its authored
baseline and report it once, as a `TypeError` whose message starts
`paste.ui.<module> #<id>: ` (the tag name for a host without an id), thrown on a
later task — visible in developer tools and error trackers, with no console
logging. Other hosts are unaffected. Page or platform code that throws while
a host binds leaves that host as authored without a report.

## Numbers in attributes

Every numeric attribute the elements read takes one grammar, applied to the
attribute text exactly as authored — nothing is trimmed:

- a whole number is digits only: `data-sticky-min-width`, `data-spy-min-width`,
  `data-paste-form-timeout`, imagesequence's catalog indices and
  `data-sequence-scrub-buffer-frames`;
- a decimal is digits with an optional fraction, or a fraction alone (`4`,
  `4.5`, `.5`, `4.`): `data-paste-marquee-duration`, `data-hero-min-opacity`,
  imagesequence's `-ms` durations, and each of the two whitespace-separated
  fractions of `data-scrub-window`.

A sign, an exponent, a hexadecimal or binary prefix, a unit or surrounding
whitespace makes the value something other than a number; each attribute's
documentation says what then applies. The CSS cap
`--paste-resolution-max-width` is read from the computed custom property: a
positive plain decimal there is the cap, and anything else means no cap.

## Development checks

Before completing a change, run `tests/run-all-checks.sh`. It must be green:
syntax, the full Node suite, source headers, a fresh marquee build with
identity verification, and both browser suites on Chromium, Firefox and
WebKit. Set `PASTE_CORE_JS`, `PLAYWRIGHT_JAVA_CLASSPATH` and, if necessary,
`PASTE_ASSETGRAPH_BIN` to installed dependencies first. The script owns its
marquee fixture server; logs land in `target/all-checks/`.

`node tests/mutate-changed.cjs [base..head]` is an optional, local mutation
gate, not part of CI. Without a range it examines executable changes against
HEAD, including untracked modules. With a range it tests the right-hand
revision. It snapshots modules and the current tests to temporary storage, uses two
isolated workers, and runs each owning suite through `PASTE_SOURCE_ROOT`, leaving the checkout untouched.
The JSON report names surviving mutations and timeouts; either makes the
command fail. Inspect survivors for equivalent changes or missing behaviour
assertions. `PASTE_CORE_JS` is required for suites that read real core files.


Each Elements browser scenario records its protected behavior, regression
assertions and observed positive controls in `results.json`. Missing
controls or incomplete `define()` dependency chains fail the run. Deliberate
capability-absence checks cite a successful positive twin in the same engine.
A filtered run of such a check includes its named twin; a full run also
verifies that every Element has browser coverage.

Shared fakes model direct mutation records, explicit intersection deliveries,
ResizeObserver registration, frame phases, Bounds coordinates and image URL
reflection. They do not compute CSS layout, intersection geometry, smooth
scroll trajectories or animated background values. Unsupported requests
throw `not modelled`; browser checks own those behaviors. A test that supplies
specific transition values is a discrete input fixture, not a simulated CSS
animation.


`PASTE_CORE_JS` must name the `src/js` directory of a `paste` release or
checkout. The event and Bounds parity checks and the fixture host checks need real
core files and fail, locally and in CI alike,
when it is unset; they never skip, since a guessed sibling path would test
against a checkout that may not exist. Export it before anything else so the
suite, the fixture host and the browser checks all read the same value. A
shallow fetch under the ignored `target/` directory is enough. The commands
below fetch the core commit CI tests against — the `PASTE_CORE_SHA` pinned in
`.gitlab-ci.yml` — the same way the CI job does, anonymously, and check that the
checkout is exactly that commit:

```sh
core_sha="$(sed -n 's/^ *PASTE_CORE_SHA: "\([0-9a-f]*\)".*/\1/p' .gitlab-ci.yml)"
git init --quiet target/paste
git -C target/paste remote add origin \
    https://gitlab.com/tomshley/brands/global/tware/tech/products/paste/paste.git
git -C target/paste fetch --quiet --depth 1 origin "$core_sha"
git -C target/paste checkout --quiet --detach FETCH_HEAD
test "$(git -C target/paste rev-parse HEAD)" = "$core_sha"
export PASTE_CORE_JS="$PWD/target/paste/src/js"

node --test 'tests/*.test.cjs'               # every contract suite

PLAYWRIGHT_JAVA_CLASSPATH="$EXISTING_PLAYWRIGHT_CLASSPATH" \
    tests/run-elements-browser-checks.sh     # real Chromium/Firefox/WebKit checks
```

`serve-examples.cjs` binds 127.0.0.1 only and answers only requests whose Host
names a loopback address. It serves exactly these: the pages under
`examples/`; the module sources under `modules/` at their dist URLs
(`/js/paste/ui/<module>.js` for an element, `/js/paste/ui/utilities/<module>.js`
for a utility); the core `paste` files under `/js/paste/` from
`PASTE_CORE_JS`; the generated PNGs the pages reference
(`/generated/img/<name>/r<index>.png` and the sequence frames under
`/generated/sequence/`); and its own `/fixture-identity` record. A path is
matched against the request target exactly as the client sent it, before any
decoding or normalization, so only the declared spelling is served. Any
undeclared path or alias spelling answers 404: a percent-escape (`%2F`
included), a backslash, a `.` or `..` segment, a repeated slash, a utility
under the element path or an element under the utility path, an extra
directory, a missing extension, or a frame or tier number written with leading
zeros. A malformed request answers 400. The port argument defaults to 8087;
`0` binds a free port, and the startup line names the port actually bound.
The browser runner starts and stops its own fixture; to aim the checks at an
already-running instance instead, run the fixture host by hand and export
`ELEMENTS_URL`:

```sh
node tests/serve-examples.cjs 8901 &
ELEMENTS_URL=http://127.0.0.1:8901/ tests/run-elements-browser-checks.sh
```

Before any browser launches, `tests/verify-fixture-identity.cjs` checks that
the fixture answering at that URL serves this checkout's module bytes and the
`PASTE_CORE_JS` core bytes for every script the example and check pages load.
It accepts the base URL with or without a trailing slash and refuses any host
that is not loopback.

The browser runner reuses an existing Playwright Java runtime and
installed browsers; nothing is downloaded. Results and evidence land under
`target/browser-checks-elements/`.

`PASTE_SOURCE_ROOT` points the behaviour suites at a different module tree:
every module a suite evaluates through `tests/fakes.cjs` — the event parity
check's page included — comes from that tree. The source gates in
`source-headers.test.cjs`, the fixture host check, and the assertions inside
behaviour suites that read source text (module headers, the documented
examples, stylesheets, source-shape checks) always read this checkout's
`modules/`. The tree must hold plain, unhashed copies of the module sources,
each either at its asset path (`paste/ui/<module>.js`,
`paste/ui/utilities/<module>.js`) or nested as in `modules/`
(`<module>/<module>.js` for an element, `utilities/<module>/<module>.js` for a
utility). Fingerprinted or renamed build output (for example hashed
paste-assetgraph file names) is not resolvable; copy or link the files into
that layout first. A file missing from the selected tree fails its suite — it
never falls back to this checkout.

```sh
PASTE_CORE_JS=/path/to/paste/src/js PASTE_SOURCE_ROOT=/path/to/flat-copy \
    node --test 'tests/*.test.cjs'
```

## Migration notes

These changes alter behaviour or requirements that existing pages may rely
on.

**Source layout.** The utilities moved under `modules/utilities/`:
`modules/throttle/throttle.js` is now `modules/utilities/throttle/throttle.js`,
and `modules/animation-frame/animation-frame.js` is now
`modules/utilities/animation-frame/animation-frame.js`. Module names
(`paste.ui.utilities.throttle`, `paste.ui.utilities.animation-frame`) and the
built URLs derived from them are unchanged. Anything that names the source
files by path — a page listing them by hand, a copy step, a WebJar resource
path — must use the new paths; a paste-assetgraph build that discovers modules
through `include-paths` needs no change.

**Script requirements.** Pages that list module files by hand (rather than
through a manifest-driven combo, which orders dependencies itself) must list
every module's dependencies before it: `paste.event` before
`paste.ui.utilities.imageresolution`, each utility before the elements that
require it. A module defined before one of its dependencies may never
activate. Core `paste` requests the missing dependency itself from its
`packagesUrl` (default `/paste/`) as `<packagesUrl><module name>.js`, which a
page serving files under other paths answers with a 404 and an uncaught
`Error loading resource. Max attempts reached.`; the dependency's own script
tag arriving later does not activate the waiting module unless another module
that requires it is defined after that.

| Module | Dependency changes |
| --- | --- |
| `paste.ui.form` | adds `paste.event` |
| `paste.ui.stickynav` | adds `paste.has` |
| `paste.ui.heroscroll` | adds `paste.has`, `paste.ui.utilities.animation-frame`, `paste.ui.utilities.mediaquery`; drops `paste.guid` |
| `paste.ui.smoothscroll` | requires only `paste.dom` and `paste.event`; no `paste.util`, `paste.has` or `mediaquery` |
| `paste.ui.autogrow` | adds `paste.ui.utilities.animation-frame`; drops `paste.util` |
| `paste.ui.scrollspy` | adds `paste.ui.utilities.animation-frame`; drops `paste.util` |
| `paste.ui.marquee` | adds `paste.ui.utilities.animation-frame`, `paste.ui.utilities.mediaquery` |
| `paste.ui.multistate` | drops `paste.guid` |

A dropped dependency can still be needed by another module on the page:
`paste.event` itself requires `paste.guid` and `paste.util`, and `paste.dom`
requires `paste.util` and `paste.oop`.

**Reduced motion.** Elements that drive animations in JavaScript read the
preference through `paste.ui.utilities.mediaquery`: a preference the platform cannot report (no
`matchMedia`, a throwing one, or a query with no listener API) counts as
reduced. Native smooth scrolling follows the page's CSS motion policy.

- **smoothscroll**
  - No longer publishes `scrollTo` and no longer listens for a window
    `smoothscroll` event. Use a same-document link inside
    `data-paste-smoothscroll`, or the native `element.scrollIntoView()`.
  - Fragment links navigate natively. The module never prevents the click,
    never writes history and never requests a scroll: the browser updates the
    address, `:target`, history and `hashchange`, reveals a target inside a
    closed `<details>` or `hidden="until-found"` where the engine supports it,
    and scrolls with the page's CSS. A link fires `hashchange` again, so
    hash-driven scripts see in-page links as they do without the module;
    `paste.ui.multistate` keeps its selection across a fragment with no
    `key:value` token.
  - What remains is focus: after a primary click on a same-document fragment
    link that resolves to an element, the target takes focus once the
    navigation lands (`hashchange`, or the next task for the fragment already
    current), with `preventScroll`. An unfocusable target borrows
    `tabindex="-1"` until focus moves on. A click a later handler prevents,
    and Back and Forward, move no focus. The wait for `hashchange` ends a
    short grace after the task that follows the click: a click the browser
    never navigates (a link inside an editable region, a navigation a script
    cancels) moves no focus, and a later, unrelated navigation to the same
    fragment takes none either.
  - A fragment resolves as the browser resolves it: an element with that id, else
    the first `<a name>` with it, raw before percent-decoded. In a quirks-mode
    document some engines also match a name regardless of case (the first such
    anchor, even ahead of an exact match; Chromium for most letters, so the
    long s, the Kelvin sign, final sigma, the micro sign and letters outside
    the basic plane match their letters, WebKit for ASCII letters only) and
    others do not; there a name that matches once each code point is folded to
    the lowercase of its uppercase form counts too, and focus follows the
    element the browser made its `:target`, provided its id or folded name
    answers the fragment. Chromium also matches a few pairs that fold
    differently (some ligatures, Greek letters with diacritics); those take no
    focus. A link targeting `_self`, the window's own name, or `_parent` or
    `_top` from a top-level document navigates in place and is handled like an
    untargeted link; a link's own `target` attribute, even an empty one,
    outranks `<base target>`.
  - The JavaScript timer loop, touch-specific policy, nav-height subtraction
    and moving-target correction are removed. History entries are the
    browser's: a link to the fragment already current adds none, and Back and
    Forward restore each entry's scroll position.
  - CSS owns motion, reduced motion and header clearance. The
    `paste.ui.sectionnav` stylesheet supplies a target clearance (see Section
    Navigation); supply motion in the page stylesheet, for example:

    ```css
    html { scroll-behavior: smooth; }
    @media (prefers-reduced-motion: reduce) {
      html { scroll-behavior: auto; }
    }
    ```

    A page without the section nav stylesheet supplies clearance itself, with
    `scroll-margin-top` on targets or `scroll-padding-top` on the scrolling
    container. These native rules also apply with JavaScript disabled.
  - A section that takes focus is drawn with the user agent's focus ring where
    the engine shows one (keyboard use everywhere, mouse clicks in some
    engines). A page that wants no ring on borrowed focus can write
    `:where(:target[tabindex="-1"]:focus) { outline: none; }`.
- **stickynav**
  - No longer clones `.fixed-nav-content` into the fixed navigation. Style it
    through the stuck class instead, for example
    `.fixed-nav-content { display: none; } .paste-fixed-subnav
    .fixed-nav-content { display: block; position: fixed; top: 0; left: 0;
    right: 0; }`.
  - No longer inserts a marker element before `.sticky-nav-target`, and no
    longer reads `#paste-ui-nav` or `#content`. `#_paste_ui_nav_wrap` is
    optional: when present it should be a header fixed or sticky at the top of
    the viewport, and its height is the offset the nav sticks at; without it
    the offset is 0. The `stuck` property on the target element is gone.
  - The stick threshold follows the content above the target as it is drawn,
    including ancestors' transforms and zoom, but not a previous sibling's own
    transform: a `transform` or `translate` on it (a `translateZ(0)` hint, a
    scroll-linked parallax, an entrance animation) no longer moves the
    threshold, before or after a resize while stuck. A sibling's `rotate` and
    `scale` properties are not taken out. When the target has no in-flow
    previous sibling it sits at its parent's content top, inside the border
    and padding; a sibling hidden at a breakpoint while the nav is stuck hands
    over to the next anchor with the margins that apply there.
  - A target with no box of its own (for example `display: none` at a
    breakpoint) does not stick until it is shown. Where `ResizeObserver`
    exists, a box change of the target, its parent or the root element
    re-measures, so a target revealed later or content growing above it needs
    no resize. A `display: contents` target is measured through its first
    child that draws a box.
  - The `paste-fixed-subnav` class lands on the element
    `paste.dom.getDocumentBody()` returns — `<html>` in standards mode, as
    before.
  - `navStuck` and `navUnstuck` (kept from the original stickynav as
    documented exceptions to the declarative-only rule) fire only on the stick
    and unstick transitions, never once per scroll, and only after the class
    write, so a listener always observes the class it is told about. They are
    dispatched on the document with the target as payload.
  - `data-sticky-min-width` (on the target, else on `.paste-ui-section-nav`)
    takes whole numbers only, and `"0"` is honoured. Any other spelling, such
    as `"768px"`, is ignored and the next source applies; with neither, the
    minimum is 0.
- **scrollspy**
  - `data-spy-min-width` takes whole numbers only; anything else means no
    minimum.
  - Touch devices without `data-spy-touch` bind nothing.
  - Links that share a parent element keep it lit across their sections.
  - The last section lights at the bottom of the page only after the page has
    scrolled, measured against the live document height, and only while that
    section's top is in view.
- **autogrow**
  - Activates only on `textarea[data-paste-autogrow]`; the `.autogrow` class
    alone no longer activates it. Minimum and maximum heights are CSS.
  - Sizing follows the `input` event — typing, delete, cut, paste, undo —
    rather than `keyup`.
  - The mixin no longer sets `resize: none`, so the browser's resize handle is
    visible and works with or without JavaScript; a height the user drags to
    becomes the floor. Add `resize: none` in page CSS to hide the handle.
  - The mixin's `$transition` now defaults to `null` and emits no
    `transition`. A value passed explicitly is still emitted, but a height
    transition never runs on a sizing pass: each pass collapses the field to
    `height: 0` to measure its content (`auto` would fall back to the `rows`
    height), and a field with any non-zero transition duration or delay has
    `transition-duration` and `transition-delay` held at `0s` (inline,
    `!important`) for the pass, so the field still shrinks as text is
    deleted. The field's own inline values are put back afterwards — an
    inline `transition` shorthand, `var()` included, exactly as written — and
    a transition running on another property keeps running. A style change
    an earlier write in the same frame left pending (a class on the field or
    an ancestor) is applied before the hold, so it transitions with the
    author's durations.
  - A field that is not rendered when the module runs takes its floor when it
    first renders. A collapse that clamps the page's or the nearest scrolled
    ancestor's offset puts it back.
- **multistate**
  - Kept from the original multistate as documented exceptions to the
    declarative-only rule: `initialize(force)` (`initialize(true)` re-scans
    the document and keeps the markup's authored defaults),
    `events.multistatepop`, `getCurrentState()`, `serializeState()` and
    `deserializeState()`. The objects they hand out are plain objects.
  - Radios are no longer renamed or given generated ids. A key whose radios
    carry no authored `name` gets one generated name per strip, so each strip
    is its own native group for arrow keys and Tab. Strips follow the markup:
    a radio's strip reaches up to its highest ancestor that holds no two of
    the key's radios with one value, never past a `fieldset`,
    `[role=radiogroup]` or `[role=tablist]`. Radios that are each alone in
    such an ancestor and sit side by side (under one parent, or in the cells of
    a table's rows or the items of a list) split into a new strip where a value
    repeats; when that would need more strips than the most repeated value has
    radios, the strips are interleaved (a grid filled row by row, a table with
    a strip per column) and the nth radio of each value joins the nth strip
    (interleaved strips that differ in values need authored names). In flat
    markup such as `x y z x y`, `z` stays with the first strip; wrap
    each strip, or declare a group, to place it. Strips may offer different
    values. The first strip is named `paste-ui-multistate:<key>`, the next
    `paste-ui-multistate:<key>:1`, then `:2`. A key holding `:` or `%` is
    encoded by `encodeURIComponent` in the name, so key `a`'s second strip and
    key `a:1` (`paste-ui-multistate:a%3A1`) never share a group. Every strip
    shows the selection. A key where any radio carries an authored name is left
    exactly as authored.
  - A `hashchange` or `popstate` to a fragment with no declared `key:value`
    token (a plain `#anchor`, or the `#` of `<a href="#">`) keeps the current
    selection; only a `popstate` to an entry with no fragment restores the
    authored defaults. Foreign `key:value` tokens in the fragment are
    preserved.
  - An input change applies the selection before writing history, pushes a
    `null` state, and keeps the selection applied if the browser refuses the
    history write.
  - Keys and values are written to the fragment with `encodeURIComponent` and
    decoded when read, and each part of the reflected class
    `multistate-state-<key>-<value>` is encoded the same way: a value
    `north america` is written `north%20america` in both. Keys and values made
    only of ASCII letters, digits and `-_.!~*'()` are unchanged. Text holding
    a lone surrogate, which `encodeURIComponent` refuses, has each surrogate
    written `%uXXXX`; such a selection works on the page but is not restored
    from the address.
- **marquee**
  - `paste.ui.marquee.init(root)` and its controller are removed; roots bind
    once, when the module is defined.
  - `data-paste-marquee-duration` is re-read on each refresh, and must be a
    plain decimal greater than zero written without padding; a hexadecimal,
    binary, exponent or signed value, or one with surrounding whitespace, keeps
    the list static.
  - The bind, resize and child-list refreshes run in the shared
    `paste.ui.utilities.animation-frame` batch rather than in a task of their
    own.
  - The item gap is measured from the laid-out items (or resolved from a px or
    percentage `column-gap`), so percentage gaps are honoured. While the list
    runs, a change to the computed gap — a breakpoint, or a viewport-relative
    gap across a resize — moves the running pitch with it.
  - Item geometry under a transformed or zoomed ancestor is written in the
    list's own layout pixels, so a scaled list no longer overlaps its items or
    stays static.
- **heroscroll**
  - No longer assigns generated ids to heroes. A `data-hero-hashclick` hero
    navigates to its next element sibling, resolved when the click happens,
    when that sibling is a hero: to a hero with an id by fragment navigation
    (the address, history, `:target` and `hashchange` follow, with the page's
    scroll CSS), and to the fragment already current by `scrollIntoView()`. A
    hero without an id gets a history entry of its own (`history.pushState`
    with the current state) before `scrollIntoView()`, so each Back returns to
    the hero the visitor left in every engine. The entry keeps the address,
    except that a fragment naming an element as the browser resolves it (in a
    quirks-mode document, an `<a name>` that matches once each code point is
    folded to the lowercase of its uppercase form counts) or the top of the
    document becomes the empty fragment (`page#`): the address no longer names
    what the entry does not show, and no engine scrolls to it on Back or
    Forward. Other fragments, such as `paste.ui.multistate` tokens, are kept,
    and an address with a `#` keeps it, so the entry never reads as the page's
    bare first entry unless the visitor was on that entry. The hero carries
    `paste-ui-hero-destination` until the next hash click, and the section nav
    stylesheet's clearance applies to it. It no longer dispatches a
    `'hashchange'` paste event with `{newURL, updateHash: false}`, which
    nothing consumed. A click whose path — the composed path, so controls
    inside shadow roots count — passes through a link (`a[href]`, `area[href]`,
    an SVG link), a button, a form control, a label, a summary, media controls,
    an embedded frame or object, `[tabindex]` or `[contenteditable]` inside the
    hero is never prevented.
  - Hero bounds are re-measured when the body changes size and once when the
    document finishes loading, so an image, a font or content arriving above a
    hero no longer leaves its content at the fade of its earlier position.
  - `force-full-height` follows viewport resizes whatever the reduced-motion
    preference. On touch devices it is re-applied only when the viewport width
    or the screen orientation changes, so the browser toolbar showing or hiding
    never shifts the content below the hero.
  - `data-hero-min-opacity` is a floor (0–1) the fade writes, not a cut-off.
    A percentage or keyword `background-position` no longer offsets the
    parallax.
- **form**: when `FormData` or `paste.io` throws, or `paste.io` starts no
  request, the submit is not taken over: it proceeds natively and the target
  is never marked busy.
- **throttle**: wrappers created without an id never share a window. A string
  id names a shared window by its text; any other truthy id names one by
  identity. The trailing call uses the latest arguments; leading mode also
  fires one trailing call when calls arrived during the window. A window opens
  only once its timer is scheduled.
- **animation-frame**: treat the id `request()` returns as opaque and cancel
  it only through `cancel()`. Neither `request()` nor the new
  `requestPhased(read, write)` runs a callback before it returns. Each batch
  runs every phased read, then every plain callback, then every phased write.
  Batches ride the unprefixed `requestAnimationFrame` and
  `cancelAnimationFrame`; the timer fallback for hosts without them and the
  prefixed APIs are removed. Callbacks receive the host frame's time on the
  `performance.now()` clock, strictly increasing from one batch to the next;
  a page wrapper that calls back without a time gets `performance.now()`. A
  page wrapper that calls back inside `requestAnimationFrame` itself (a
  synchronous flush helper) has that call ignored, and one that throws has
  its error dropped; either way that batch runs from a timer 20 ms later
  instead, and `request()` still returns normally. When such a wrapper has
  also registered a real frame, whichever of the frame and the timer arrives
  first delivers the batch and the other runs nothing, so each batch is
  delivered once; the timer is a little longer than a frame, so the real
  frame usually wins.

## Why Source-Only?

This package contains **source code only**—no compiled output.
The [`paste-assetgraph`](https://github.com/PasteStack/paste-assetgraph) pipeline handles:

- SCSS → CSS compilation
- JS/CSS minification
- Dependency graph extraction
- Topological sorting
- Fingerprinting / hashing
- Manifest generation

## License

Apache License, Version 2.0. See `LICENSE` and `NOTICE.md`.
