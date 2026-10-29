# Paste Elements

**Paste Elements** is the core UI kit for the Paste ecosystem.

YUI-style modules keep behavior and styling together where both are needed.
SCSS-only components and structure do not require JavaScript.
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
│   ├── smoothscroll/           # Optional controlled anchor movement/history
│   ├── scrolltop/              # Declared links to the current page return to the top
│   ├── stickynav/              # stickynav.js, stickynav.scss
│   ├── scrollspy/              # scrollspy.js, scrollspy.scss
│   ├── sectionnav/             # sectionnav.scss, _mixin.scss (no JS)
│   ├── autogrow/               # autogrow.js, autogrow.scss, _mixin.scss
│   ├── allowed_chars/          # Typed-character filtering
│   ├── imageupload/            # Paired file, URI, preview and status
│   ├── js_tooltip/             # Authored rich help (+ optional SCSS)
│   ├── multistate/             # multistate.js, multistate.scss
│   ├── navigate_on_change/     # Explicit control-value navigation
│   ├── prevent_double_submit/ # Native navigation submission guard
│   ├── sortable/               # Fixed-slot content swapping
│   ├── update_text_on_input_change/ # Safe text-node reflection
│   ├── marquee/                # marquee.js, marquee.scss, _mixin.scss
│   ├── form/                   # form_validity, form_apply, form_html, form_autosave; shared form styles
│   ├── button/                 # button.scss, _mixin.scss (no JS)
│   ├── address/                # address.scss, _mixin.scss (no JS)
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
│   ├── vendor/                 # JSLint, used by the lint gates (see NOTICE)
│   ├── serve-examples.cjs      # Loopback fixture host for examples/
│   └── run-*-browser-checks.sh # Playwright Java runners (no downloads)
│
└── examples/                   # Development only — not part of the package
    ├── index.html              # Lists the pages the fixture host serves
    ├── reading.html            # scrollscrub progress property
    ├── sequence-hero.html      # imagesequence intro + range, scrollscrub, resolution
    ├── avatars.html            # progressiveresolution under an authored cap
    ├── heroscroll.html         # heroscroll parallax and image fade
    ├── stickynav.html          # declared sticky target and CSS-owned nav state
    ├── marquee.html            # Built by tests/build-marquee-example.cjs
    ├── sectionnav.html         # Built by tests/build-sectionnav-example.cjs
    └── *.conf                  # Hand-authored inputs to those example builds
```

The published package is source only: `base/`, `modules/`, `structure/`,
`README.md`, `LICENSE`, `NOTICE` and `VERSION`. Tests, the vendored test
tooling and the examples stay in the repository; `.gitattributes` marks
`tests/` and `examples/` `export-ignore`, so source archives built from a tag
leave them out too.

## Sass ownership and migration

`base/mixins` provides shared variables and helpers without emitting CSS.
`base/base` deliberately adds the global reset. It does not choose a form,
button or address skin for the application.

**Import migration:** if your application relied on those styles previously
emitted by `base/base`, explicitly retain them in the same place, before your
application overrides:

```scss
@import 'base/base';
@import 'modules/form/form';
@import 'modules/button/button';
@import 'modules/address/address';
```

These are the existing presentation defaults, separated from the baseline.
Import only the presentation your application wants. Form behavior remains an
independent JavaScript choice. Existing form-field/formfield aliases remain.

Structure follows the same distinction. `structure/grid/mixin` defines
`paste-grid()` without output; `structure/grid/grid` includes it to emit the
standard grid. Layout, spacing and typography provide corresponding
`paste-layout()`, `paste-spacing()` and `paste-typography()` mixins and retain
their existing default stylesheet entry points. Set their existing `!default`
variables before importing. Do not import the emitting entry point and include
the same mixin again unless duplicate output is intended.

For scoped typography, explicitly choose the current selector as its root:

```scss
@import 'structure/typography/mixin';
.article {
  @include paste-typography($root: '&');
}
```

The default `structure/typography/typography` entry still styles `body` and
headings globally. Component definition imports (`modules/form/mixin`,
`modules/button/mixin`, `modules/address/mixin`) are also silent. Their mixins supply declarations to the selector that includes them:

```scss
@import 'modules/button/mixin';
@import 'modules/address/mixin';
@import 'modules/form/mixin';

.checkout-submit { @include paste-ui-button(); }
.shipping-address { @include paste-ui-address(); }
.checkout-field { @include paste-ui-form-field(); }
.checkout-help { @include paste-ui-form-description(); }
.checkout-error { @include paste-ui-form-error(); }
```

No Paste wrapper class is required by these mixins. Field descendants and states
remain relative to the chosen field selector. The default component stylesheets
choose the existing selectors using `$paste-prefix` (`paste-ui` by default),
then include those same mixins. Set the prefix before importing a default
stylesheet if you want its class names changed. The structure bundle mixins
above generate a collection of standard selectors; they are not single-element
declaration mixins.

The grid styles exact generated column classes, including `.paste-col-auto`.
It no longer styles arbitrary classes containing `paste-col-`. Custom columns
must own their declarations. The column count must be a positive unitless whole
number, and container breakpoint names must exist in `$paste-breakpoints`;
invalid configurations now fail compilation.

Standalone helper imports load their defaults themselves. `strip-units()`
returns a number; `$unit-default-px` respects a value set before import.
Demo fragment IDs are page-specific and remain paired with their anchor links.

Validate these boundaries with the project's assetgraph executable:

```sh
PASTE_ASSETGRAPH_BIN=/path/to/paste-assetgraph node tests/style-contract-checks.cjs
```

Add `--browser` with `PLAYWRIGHT_MODULE` and `ELEMENTS_BROWSER_EXECUTABLE` set
for native Chromium checks of selector isolation, scoped typography, hidden
controls and forced-color focus. These checks use unminified output; correctness
must not depend on an optimizer. Repeat with `--minify --browser` to check the
optimized output as well.

The `autogrow`, `heroscroll`, `imagesequence`, `marquee`, and `sectionnav`
component mixins also style the caller's selector. The corresponding emitting
stylesheet selects Paste's default root. Definition imports alone emit no CSS:

```scss
@import 'modules/autogrow/mixin';
@import 'modules/sectionnav/mixin';
.contact-notes { @include paste-ui-autogrow(); }
.site-navigation { @include paste-ui-sectionnav(); }
```

**Mixin migration:** put an existing root-level include inside its intended
root selector, or import the emitting stylesheet for the existing Paste defaults.
Hero, marquee and section-nav child role classes remain part of their markup
contract. Section-nav target clearance remains a deliberate document rule;
pass `$target-clearance: null` to omit it. Disclosure scroll locking is scoped
to targeted panels inside the caller's root. Marquee direction inheritance and
its namespaced keyframes remain deliberate global rules. These style choices
leave JavaScript activation attributes and classes unchanged.

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

<script src="/paste/site-1/paste.ui.heroscroll.min.js" defer></script>
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
| smoothscroll | ✓ | - | Optional motion and independently controlled history |
| scrolltop | ✓ | - | A declared link to the current page returns to the top without a reload |
| stickynav | ✓ | ✓ | Sticky navigation bar |
| scrollspy | ✓ | ✓ | Marks a nav item active as its section scrolls into view |
| sectionnav | - | ✓ | In-page section navigation styling |
| autogrow | ✓ | ✓ | Grow-only textarea enhancement |
| select | ✓ | ✓ | Custom appearance over a native select; reflected option label |
| button | - | ✓ | Optional button presentation |
| address | - | ✓ | Optional address presentation |
| multistate | ✓ | ✓ | Hash-driven UI state (`#key:value`) for tabs and radio inputs |
| marquee | ✓ | ✓ | One semantic list with optional CSS-driven continuous motion |
| throttle | ✓ | - | Event throttling utility (`paste.ui.utilities.throttle`) |
| animation-frame | ✓ | - | Batches DOM writes into the next animation frame (`paste.ui.utilities.animation-frame`) |
| form | ✓ | ✓ | Ordinary-form validity reflection and submission blocking |
| apply | ✓ | ✓ | Class-activated JSON submission and field messages |
| form_html | ✓ | — | Explicit submission with HTML or named JSON-fragment replies |
| fragment_navigation | ✓ | — | Opted-in anchor navigation into a named target |
| lazy_loader | ✓ | — | Caller-triggered loading of declared HTML content |
| carousel | ✓ | ✓ | Discrete pages, controls, named instances and original events |
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
to the list subtree and its interactivity attributes (`class`, `href`, `tabindex`,
`contenteditable`, `controls`); style writes are not observed. Bindings live as long as the page does. Paste loads at the end
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
      <li class="paste-ui-section-nav-item"><a class="paste-ui-section-nav-link" href="#first">First section</a></li>
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
is unsupported. The browser owns disclosure navigation. Use ordinary anchors and author
`tabindex="-1"` on a destination that needs to take focus.

Fragment targets clear the nav. The mixin emits a zero-specificity
`:where(:target) { scroll-margin-top:
var(--paste-ui-section-nav-clearance, <auto>) }` rule, where `auto` is the
nav's own box: `$height` plus the first width in `$border-bottom` (51px with
the defaults). The browser reads it when it scrolls to a fragment — a link, or
a page loaded with a fragment — so a target lands at the bottom of a fixed or
sticky section nav instead of under it. Back and Forward restore each
entry's own scroll position. Any `scroll-margin-top` rule the page writes
for its targets wins over the default.
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
snaps, the current target may rest the clearance lower than its neighbours,
and one whose area outgrows the viewport no longer snaps
firmly; other heroes are untouched. Such a page clears its chrome with
`scroll-padding-top` on the snapping scroller, which moves every snap position
alike, and zeroes the custom property as above.

Pass `$target-clearance: null` to leave targets to the page, or a length to
replace `auto`. The stylesheet does not enable smooth movement. Load the optional
smoothscroll module for its movement/history contract, or declare CSS
`scroll-behavior` when native anchor navigation is sufficient.

Build and serve the runnable example:

```sh
node tests/build-sectionnav-example.cjs /path/to/paste-assetgraph
python3 -m http.server 8078 --bind 127.0.0.1 --directory target/sectionnav-example
```

## Form

`paste.ui.form.form_html` submits a `form[data-paste-form]` that sits inside an
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
override the form's `action`, `method`, `enctype` and `target`; with an empty or missing effective
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
submission at a time: it carries `aria-busy="true"`,
`paste-ui-io-html-fragment-busy` and `.paste-ui-formhtml-busy` while the background request is pending. This is one busy
state; preparation alone, invalid/native submissions and ignored duplicate
submissions do not create another state. The class is a styling hook on the
reply target, not on the form. The form busy class clears and the prior
`aria-busy` value is restored when its owner settles, before failure notification or replay. Existing unrelated classes stay
intact. While a request is in flight further submits from any form inside it —
or inside a target around it or within it, whose reply would replace it or be replaced by it —
are ignored. A committed independent fragment write can supersede the pending
request; a superseded or detached form never replays or adds a failure notice. The
request carries a deadline — `data-paste-form-timeout` in decimal
milliseconds on the form, default 30000; positive integers through
4294967295 are honored and the literal `0` opts out, while blank, fractional,
signed, scientific-notation, hexadecimal or overflowing input falls back to
the default rather than disabling the deadline silently. The shared operation
sets the native XHR timeout before sending; no second deadline timer is needed.
A stalled request cannot hold the busy state forever.

An HTML or matching named JSON-fragment response of any status whose final URL is on the
page's origin replaces the target's content, enhances forms inside it, and
focuses the first `[role="alert"]` or `[role="status"]`. Every other outcome
after transmission — a network error, timeout or abort, or a response the
form cannot place (an unsupported/malformed reply, or a reply whose final URL left
the page's origin) — follows one rule: the busy state clears, then the form
dispatches `paste.ui.formhtml:failed`, a bubbling, cancelable event whose
`detail.reason` is `"error"`, `"timeout"`, `"abort"` or `"response"`. A
listener that calls `preventDefault()` owns the failure UX; otherwise the form
resubmits natively only where a replay cannot duplicate the submission — a
`get`, or a form carrying `data-paste-form-idempotent`, which declares that
the endpoint itself collapses replays (an idempotency key or equivalent;
the attribute alone provides no protection). Any other failure appends and
focuses a `paste-ui-formhtml-failure` `role="alert"` notice inside the form —
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
failure keeps its replay rule. The native deadline reports
`"timeout"` and keeps its replay. A request that could
not be transmitted at all is the single exception: it submits natively
unconditionally, because nothing was sent.
An
already default-prevented submit, a form without an IO reply fragment target,
a browser that does not report the submitting
button (`SubmitEvent.submitter`), a browser whose `FormData` does not take
the submitting button (`new FormData(form, submitter)`), an image submit
button, a `noreferrer` form, a `post` encoded as `text/plain`, a target naming a browsing context
other than `_self`, a form whose submit would not go out as UTF-8 (or that declares
`accept-charset` in a browser without `TextDecoder` to resolve it), or a
browser missing `WeakMap`, `XMLHttpRequest`,
`XMLHttpRequest.responseURL`, `FormData`, `URLSearchParams`, or `URL` submits
normally — nothing is intercepted.

Paste loads at the end of the document, after the markup it enhances, so forms
present when the module runs are enhanced immediately, and forms inside a
swapped-in IO reply fragment are enhanced as they are placed. Each form is
enhanced once; the module exposes no public API.

## Apply and deferred content

`paste.ui.form.form_validity` owns native validity reflection and blocking. Select
`form.paste-ui-apply` plus `paste.ui.form.form_apply` for the original JSON
`success.message`/`error.message`/`error.param` flow; select
`form.paste-ui-formhtml` plus `paste.ui.form.form_html` for HTML replies. Both keep
ordinary native form fallback. Loading the validity module alone does not
intercept network submission. Use only one submission enhancement per form.

`paste.ui.lazy_loader` keeps the separate `data-lazy-load` contract and four
APIs: `load_lazy_content(element)`, `load_all_content(parent)`,
`load_visible_content(parent)` and `set_init_new_content(callback)`. A caller
invokes it after a meaningful transition, such as showing a radio-selected
panel. Visible means positive layout width and height, not viewport intersection.
The loader installs no automatic observers or event listeners. It suppresses
concurrent duplicate requests, leaves failed declarations retryable, and calls
the hook after inserting successful trusted HTML and removing the declaration.
`data-lazy-load-timeout` declares the request deadline in decimal
milliseconds, default 30,000, `0` for none.

`paste.ui.carousel` restores discrete paging, generated controls,
optional indicators/counter, named instances, movement events, swipes and
cycling. Its mixin and default stylesheet follow the existing opt-in split.
Without enhancement, authored slides remain ordinary content. See the matching
Surface contracts for attributes, methods, intentional fixes and markup.

The shared `paste.ui.utilities.form-dom` boundary reads native form members
without letting named controls shadow them. It neither mutates the form's API
nor bans field names. Form modules use it for DOM members and native listener
registration; it creates no automatic listeners or per-form cache. Collection
access also uses the native `HTMLFormElement.elements` getter.

For named external libraries, use the app-owned wrapper/JAM example in
[examples/external-libraries](examples/external-libraries/README.md). The app
owns the library version and URL; no new loader or Surface element is required.

## Shared HTML fragment operation

`paste.ui.utilities.io-html-fragment` is a caller-triggered utility. Forms,
marked links and lazy loading use its `load(target, options)` operation. Autosave
uses `apply(data)` after independently acknowledging its successful save.
The utility does not discover triggers, submit forms, navigate, initialize other
modules, execute scripts, load envelope assets or keep a content cache.

`load` accepts `url`, optional `method` (GET), `body`, `contentType`, and `timeout`
(30,000 milliseconds; zero disables it). `prepare()` may supply the request's
`url`, `method`, `body` and `contentType` after reserving the target; forms use
this because constructing FormData can synchronously dispatch `formdata`.
`onStart()` runs immediately before transmission. Optional `beforePlace()` runs
after the response markup is validated and immediately before its DOM write;
link navigation uses it to establish the destination URL for relative resources.
`onDone(response, status, xhr)` runs after placement and release. `onFailed(reason, sent)` runs after release;
reasons are `unsupported`, `busy`, `request`, `response`, `error`, `timeout`,
`abort`, `stale` and `superseded`. Completion callbacks are required. A caller may provide
`deferFailure(reason, complete)` to retain the target until its owned failure
decision runs; it must call `complete()`. Form replay uses this for one task
so native navigation can take precedence. Supersession still retires that decision. The returned
operation has `cancel()` for silent cancellation; a refused start returns null.
An optional `isCurrent()` predicate lets an explicit caller invalidate its own
request before placement. XHR timeout and terminal handlers are set before send.

Only HTTP(S) requests on the page origin and responses whose final URL is on
that origin are eligible. The target must remain in the document. A missing
required capability or malformed target format leaves callers their native
fallback. A caller must supply a real element target, valid options and trusted
HTML: this operation is an HTML sink, not a sanitizer.

The target's `data-paste-io-reply-fragment-format` is `html` by default (also
when omitted), or `json`. `html` sends `Accept: text/html, application/json`;
`json` sends `Accept: application/json`. Both accept either response format.
An invalid declaration refuses the enhancement. `paste.io` supplies
`X-Requested-With: XMLHttpRequest`. Servers retain the full-page rendering at
the same URL and send `Vary: X-Requested-With, Accept`. Cache policy belongs to
the endpoint: public article fragments may be cached; personalized or token
bearing responses need their own policy. The browser utility adds no cache.

A `text/html` response replaces the target's inner markup. An `application/json`
response must contain `data.fragments[targetName].markup` as a string; only
that named target is replaced, and its descendant/root bindings receive
`data.variables`. Empty markup is valid. JSON scalar strings, including an empty
string, are not HTML replies. Malformed JSON, an absent matching fragment, a bodyless status (204, 205 or 304), another content type or an
off-origin final URL is an unusable reply.
The default accepts 2xx responses. `acceptResponse(status, xhr)` lets the
request owner decide before placement: form HTML accepts rendered error
responses, including 422 validation messages in either representation; lazy
loading keeps error replies retryable without replacing its fallback. `data.title` is optional and
used only by fragment navigation. `js` and `css` metadata remain inert.

One pending load owns its target and excludes new overlapping loads, including
ancestor/descendant targets. The target carries `aria-busy="true"` and
`paste-ui-io-html-fragment-busy`; settlement restores its prior aria value and
preserves a pre-existing busy class. A committed independent `apply(data)` write
supersedes outstanding overlapping loads. Those operations are released and
aborted, and their later replies cannot overwrite the new content. Supersession
is not a transport failure: adapters perform no failure UI or native replay.
This is a commit-order guarantee, not a global newest-request protocol.

`apply(data)` preserves the original autosave envelope behavior: own-key order,
original modules before Surface fragments, every matching live target across the
document, and a fresh target scan after each name. Bindings run after markup;
the original vocabulary accepts strings/numbers/booleans and Surface accepts strings. Missing or
malformed entries are ignored. Autosave still requires HTTP 200 and meta.code
200 to acknowledge the sent snapshot; later edits remain dirty. It applies
reply markup only while the originating form is still in the document.

## Fragment navigation

Load `paste.ui.fragment_navigation` for explicitly marked anchors:

```html
<a href="/articles/example" data-paste-io-reply-fragment="article">Read article</a>
<div data-paste-io-reply-fragment-target="article">Existing article</div>
```

The `href` is the complete navigable page URL. With no enhancement it navigates
normally. With enhancement, an ordinary primary activation requests and places
the target's representation. After validating the reply, it pushes the authored
URL (retaining its hash) immediately before placing markup. A later eligible
link supersedes this module's earlier request.
A missing or ambiguous target, modifiers, non-primary buttons, downloads,
referrer-policy declarations, noreferrer, ping, non-self browsing targets
(including base target), credentials, cross-origin
URLs and same-document links remain native. Names are matched literally, not
interpreted as selectors. Forms never acquire link navigation behavior.
`data-paste-io-reply-fragment-timeout` on the anchor declares the request
deadline in decimal milliseconds, default 30,000, `0` for none.

Committing the URL before placement lets native relative iframe, image and CSS
resource URLs resolve against the destination. If placement then fails, native
navigation replaces that new history entry instead of adding another. Wrapped
JSON may supply `data.title`; without it the title stays unchanged. Focus and
scroll move to the link's fragment ID when present, otherwise the target.
Back/Forward across paths or queries reloads the server's full page at the new
URL; hash-only traversal remains native. This works after a reload as well as
within the original enhanced document. There is no client page cache or router.
Redirected replies fall back to native navigation, preserving redirect-supplied
hashes and other browser redirect semantics that XHR does not expose. A
transmitted failure falls back to normal navigation to the authored href;
a later native navigation, including a hash-only change, cancels the pending enhancement. Busy target refusals
are ignored until their owner settles. Stale/superseded responses never navigate.

The utility leaves inserted markup's initialization to its caller. Form HTML
submission reinitializes its own replacement forms and validity. Lazy loading
retains `set_init_new_content` and its explicit single/all/visible load APIs.
Fragment navigation places document markup; other optional enhancements are
not automatically discovered or initialized by a global lifecycle system.
Newly inserted ordinary forms and links retain their native behavior.

## Structure

| Module | Description | Key Variables |
|--------|-------------|---------------|
| grid | 12-column responsive grid | `$paste-grid-columns`, `$paste-grid-gutter` |
| layout | Page structure (header, footer) | `$paste-header-height`, `$paste-footer-padding-y` |
| typography | Headings, paragraphs, links | `$paste-font-family-*`, `$paste-font-size-*` |
| spacing | Margin/padding utilities | `$paste-spacers`, `$paste-section-padding-y` |

`structure/layout/_mixin.scss` defines the optional `paste-layout()` recipe;
importing it emits nothing. Including it emits the `.paste-page`,
`.paste-header`, `.paste-main` and `.paste-footer` rules. These are distinct
from Surface's `.paste-ui-header`, `.paste-ui-main` and `.paste-ui-footer`
markup hooks. Surface does not load or opt into this structural recipe.
Compose it deliberately by adding its classes in an application layout, or
write the application's layout rules against Surface's hooks. Neither base
imports nor a component mixin should silently opt a page into that structure.

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
over), an unrendered subject or root — restores the authored inline value and
priority while the module still owns the declaration. A later writer is
preserved. With no authored value, the module removes its declaration and the
CSS `var()` fallback stands. Measuring runs in the shared animation-frame batch: a
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
on scroll in direct mode, a hidden document, reduced motion, a failure, or completion;
queued mode finishes a running intro before scroll travel (see Ordered playback).
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
With CSS `width: auto; height: auto`, loading placeholders remain browser-owned.
Use CSS dimensions when the layout must stay fixed even during a native image
update; width descriptors preserve the decoded image's intrinsic size.

An `img` with an authored `srcset` or `sizes`, or inside `<picture>`, is left
to the browser without a report.

A background frame paint stands once the computed `background-image` shows it.
While a background-image transition is in flight — as `getAnimations()` lists
it, or, where the platform cannot list animations, for a bounded time under a
declared transition — the paint is pending and sharpening waits for it to
settle; any other value, such as an `!important` stylesheet rule outranking the
frame, reverts the paint only if the module still owns the inline value and
priority. A newer inline declaration is preserved; completion work yields until
a fresh page input permits another presentation decision. Reduced-motion
restoration also preserves newer image writes. A poster restored under reduced motion
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
imagesequence and progressiveresolution share, and `mediaquery` holds the shared
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

Numeric atoms use the following grammar. Single-value attributes are read
exactly as authored — nothing is trimmed:

- a whole number is digits only: `data-sticky-min-width`,
  `data-paste-form-timeout`, `data-autosave-timeout`,
  `data-image-upload-timeout`, `data-lazy-load-timeout`,
  `data-paste-io-reply-fragment-timeout`, imagesequence's catalog indices and
  `data-sequence-scrub-buffer-frames`;
- a decimal is digits with an optional fraction, or a fraction alone (`4`,
  `4.5`, `.5`, `4.`): `data-paste-marquee-duration`, `data-hero-min-opacity`,
  imagesequence's `-ms` durations, and each of the two whitespace-separated
  fractions of `data-scrub-window`. That two-value list permits whitespace
  around and between its fractions; the individual fractions use the same
  decimal grammar.

For a single numeric value, a sign, an exponent, a hexadecimal or binary
prefix, a unit or surrounding whitespace is invalid; each attribute's
documentation says what then applies. The CSS cap
`--paste-resolution-max-width` is read from the computed custom property: a
positive plain decimal there is the cap, and anything else means no cap.

## Development checks

Before completing a change, run `tests/run-all-checks.sh`. It must be green:
syntax, the full Node suite, source headers, readable/minified style contracts,
native consistency/responsibility checks, a fresh marquee build with identity
verification, and both Java browser suites on Chromium, Firefox and WebKit.
Set `PASTE_CORE_JS`, `PLAYWRIGHT_JAVA_CLASSPATH`, `PLAYWRIGHT_MODULE` and, if
necessary, `PASTE_ASSETGRAPH_BIN` to installed dependencies first. The script owns its
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

# Compiled CSS/native semantics and operation-count regressions.
paste-assetgraph build --config tests/consistency-assets.conf
ELEMENTS_BROWSER=chromium node tests/consistency-browser-checks.cjs
ELEMENTS_BROWSER=firefox node tests/consistency-browser-checks.cjs
ELEMENTS_BROWSER=webkit node tests/consistency-browser-checks.cjs

# Marquee interactivity/scale and scrub declaration ownership.
for engine in chromium firefox webkit; do
    ELEMENTS_BROWSER="$engine" node tests/responsibility-browser-checks.cjs
done

PLAYWRIGHT_JAVA_CLASSPATH="$EXISTING_PLAYWRIGHT_CLASSPATH" \
    tests/run-elements-browser-checks.sh     # real Chromium/Firefox/WebKit checks
```

The consistency checks use Node Playwright. `PLAYWRIGHT_MODULE` may name its
installed package path, and `ELEMENTS_BROWSER_EXECUTABLE` may select a local
browser binary. `ELEMENTS_SOURCE_ROOT` can select a flat built module tree
(`paste/ui/...`), and `ELEMENTS_CONSISTENCY_BUILD` can select its CSS build. They exercise the compiled hidden guards, including
`hidden="until-found"`, without increasing component selector specificity;
native radio selection and inert non-radio markers; image-write ownership;
and inactive-path operation counts. The legacy direction check uses the actual
compiled fallback outside its capability condition. Timing benchmarks remain
separate from these correctness and work-count assertions.

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
| `paste.ui.form.form_validity` | `paste.guid`, `paste.ui.utilities.form-dom` |
| `paste.ui.stickynav` | uses `paste.dom`, `paste.event`, `paste.ui.utilities.animation-frame`; drops `paste.has` |
| `paste.ui.heroscroll` | adds `paste.has`, `paste.ui.utilities.animation-frame`, `paste.ui.utilities.mediaquery`; drops `paste.guid` |
| `paste.ui.autogrow` | uses `paste.dom`, `paste.event`; drops `paste.util` and `paste.ui.utilities.animation-frame` |
| `paste.ui.scrollspy` | adds `paste.ui.utilities.animation-frame`; drops `paste.util` |
| `paste.ui.marquee` | adds `paste.ui.utilities.animation-frame`, `paste.ui.utilities.mediaquery` |
| `paste.ui.multistate` | retains `paste.guid` for generated missing names and ids |

A dropped dependency can still be needed by another module on the page:
`paste.event` itself requires `paste.guid` and `paste.util`, and `paste.dom`
requires `paste.util` and `paste.oop`.

**Reduced motion.** Long-running Elements animations read the
preference through `paste.ui.utilities.mediaquery`: a preference the platform cannot report (no
`matchMedia`, a throwing one, or a query with no listener API) counts as
reduced. Smoothscroll checks `matchMedia` at the start of each movement; a
missing API or a reduced preference lands immediately. Native smooth scrolling,
native mode included, follows the page's CSS motion policy.

- **smoothscroll**
  - Optional same-document anchor motion: 500 ms cubic easing, with a history
    update independent of native fragment navigation and no synthetic hashchange.
    Plain anchor clicks push immediately; legacy marked containers and section
    navs delegate clicks, including newly inserted links, and push at completion.
  - Links are discovered when the module is defined, or at `DOMContentLoaded`
    while the document is loading; `init()` repeats discovery without
    duplicate bindings. `scrollTo(element, duration)` moves only;
    `scrollTo(id, verticalOffset)` retains the older offset/completion-history
    contract. Omitted duration is 500 ms; zero is instant.
  - The Paste `smoothscroll` event accepts `newURL`, `verticalOffset`, and
    `updateHash`. The id has no leading `#`; omitted updateHash is true, false
    suppresses history. Legacy boolean strings are case-insensitive. An event
    without a payload uses the current URL fragment.
  - Wheel input cancels motion and pending completion history. New movement
    replaces unfinished movement. Reduced motion lands immediately. No focus
    reassignment. Modified clicks, foreign destinations, downloads, other
    browsing contexts and missing targets retain native navigation.
  - Native anchors and CSS remain sufficient when these extra contracts are
    not needed. CSS smooth motion alone does not establish history equivalence.
  - Native motion: `:root { --paste-smoothscroll-motion: native; }`, read once
    when the module is defined, leaves link clicks to the browser — no link
    is discovered or bound. `scroll-behavior`, `scroll-margin-top` and
    `scroll-padding-top` own motion, reduced motion and clearance; the page
    enables smooth `scroll-behavior` only under
    `prefers-reduced-motion: no-preference`.
    `scrollTo(id)` and the event navigate to the fragment natively; a target
    the address already names, `scrollTo(element)` and `updateHash: false`
    use `scrollIntoView()`. Duration and `verticalOffset` do not apply;
    missing targets, including ones not yet parsed, are ignored. Link the
    stylesheet that sets the property ahead of the script: only a stylesheet
    linked in the markup, with no onload swap, reliably holds back the inline
    and parser-blocking scripts after it while it loads, not `async`, `defer`
    or module ones.
- **scrolltop**
  - `<a href="/" data-paste-scrolltop>`: a declared link to the current page
    returns to the top without a reload and without leaving a `#` in the
    address. The browser performs its own navigation to the empty fragment —
    the scroll, the history entry, and any `scroll-behavior` — and the
    module then rewrites that entry's address without the `#`. Back restores
    the position the click left. The rewritten entry's `history.state` is
    `"paste.ui.scrolltop"`; a repeat click replaces that entry, as a native
    `#` link does. The module scrolls nothing itself.
  - The href must name the current address's path and query, with no fragment
    or an empty one. Modified and non-primary clicks, other browsing
    contexts, `download` and `ping` links and any non-empty fragment stay
    native. From an address already ending in `#`, the click replaces that
    entry, as a native `#` link does. Nothing binds without a declaration
    when the module is defined, or without `history.replaceState`.
  - Without JavaScript the link is an ordinary link to the page.
- **stickynav**
  - Each `[data-paste-sticky-nav]` marks a nav. A nonempty attribute value
    names its target by CSS selector; an empty value uses the first
    `[data-paste-sticky-target]`. An absent target uses the nav’s initial
    document position. Invalid selectors and self targets leave it alone. Each valid nav receives `paste-ui-sticky` and, when its target's
    bottom reaches the viewport top, `paste-ui-sticky-active`.
  - The target must remain in flow and keep its geometry when the nav's class
    changes. CSS owns fixed positioning, any header offset, and any space
    reserved for the nav. `init()` discovers new declarations and
    `updateSticky()` synchronously refreshes current navs. Initialization waits
    for DOM readiness when necessary.
  - The module batches target reads before class changes in one shared frame.
    Scroll, resize, page load and optional ResizeObserver reports refresh it.
    Hidden targets stay inactive. Touch is allowed.
  - `data-sticky-min-width` lives on each nav and accepts whole nonnegative
    pixels. At or below that width the nav is inactive; invalid values mean 0.
  - Migration: replace `.sticky-nav-target` activation with the markers above,
    and `.paste-fixed-subnav .your-nav` with `.your-nav.paste-ui-sticky-active`.
    The root class, header-id measurement, `navStuck`/`navUnstuck` events and
    sibling/transform inference are removed. This deliberately restores the
    supplied declared-target/per-nav responsibility, rather than retaining
    the different historical root-event contract.
- **scrollspy**
  - `data-spy-min-width` retains decimal parseInt behavior: leading
    whitespace and numeric prefixes are accepted; no numeric prefix means no minimum.
  - Touch devices without `data-spy-touch` bind nothing.
  - Links that share a parent element keep it lit across their sections.
  - The last section lights at the bottom of the page only after the page has
    scrolled, measured against the live document height, and only while that
    section's top is in view.
  - Where `ResizeObserver` is available, body, nav and linked-section size
    changes invalidate cached geometry through the existing frame pass.
    Otherwise window resize and load remain the correction inputs.

- **autogrow**
  - Activates on `.autogrow` or `textarea[data-paste-autogrow]`. Shared
    `input` and legacy `keyup` handlers grows overflowing visible fields
    at bind and on typing, paste, cut, delete or undo. It never shrinks a field.
  - CSS owns min/max height, resizing and transitions. The height calculation
    accounts for padding and border-box sizing, honors resolved pixel caps,
    and preserves an existing inline height priority. A fitting field performs
    no computed-style read or style write. A hidden field waits for its next
    visible input event. Programmatic value changes require an input event.
  - The mixin emits no `resize` rule and no transition unless explicitly
    supplied. The module never collapses a field, suppresses a transition,
    restores scrolling, records a floor or queues a frame.
  - Migration: deletion now retains the current height. There is no automatic
    shrink behavior. The animation-frame dependency is removed.
- **multistate**
  - Ports the original implementation under `paste.ui.multistate`: the same
    state tables, selection/deselection passes, native `change` subscriptions,
    selected-panel attributes/classes, history handlers and public return object.
  - One native radio represents each key/value. Several panels may share that
    pair. Separate controls with the same key/value are not mirrored strips.
  - Author ordinary names and label ids. Existing names and ids are preserved;
    missing names receive `key + '$' + moduleGuid`, and missing ids receive a
    generated GUID. A label still needs an authored association with its input.
  - CSS owns presentation. The selector is
    `input[data-multistate-key]:checked ~ [data-multistate-state]`.
    Author that reveal rule; the module stylesheet only supplies hiding rules.
    Radios, labels and panels must have the sibling relationship the rule needs.
    For a working no-JavaScript baseline, author native group names and
    value-specific `:checked` reveal rules too. Surface's multistate spec has
    the complete example. No wrapper or layout inference is involved.
  - Initial selection combines valid fragment values with each dimension's
    authored checked default. A later explicit state fragment selects its named
    dimensions and clears omitted dimensions. Ordinary anchors, including `#`,
    keep the current selection. Back to an address with no `#` restores defaults.
  - A radio change carries the other selected dimensions and any foreign
    `key:value` data forward. It calls `pushState` before announcing the selection. The write does not navigate or generate a native `hashchange`.
    If history refuses the write, panel reflection still follows the radio.
  - Keys and values use `encodeURIComponent` in fragments and class suffixes;
    malformed URI tokens are ignored. Author valid Unicode strings. There is
    no custom `%uXXXX` encoding. Both native history event families stay bound;
    an unchanged transition emits no duplicate state event.
  - The inherited API remains: `initialize(force)`, `events.multistatepop`,
    `getCurrentState()`, `serializeState()` and `deserializeState()`.
    State dictionaries have no prototype, so keys such as `__proto__` are data.
    `getCurrentState()` and event payloads share the current dictionary, as in
    the original; treat it as read-only. A changed transition publishes a new dictionary.
    There is no snapshot-copy layer or queued reentrant-change protocol.
  - `initialize(true)` releases old change subscriptions and reflection, rescans
    the document and resolves the current fragment/defaults. Native form reset
    is not a state/history transition; this port adds no reset listener or timer.
    Use the radio interaction or navigation for enhanced state changes.
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
  - Item geometry under an axis-aligned scaled or zoomed ancestor is written in the
    list's own layout pixels, with independent horizontal and vertical scales.
- **heroscroll**
  - Whole-hero background-click navigation has been removed. Remove
    `data-hero-hashclick` and use an authored `<a href="#section-id">` with
    a matching destination `id` wherever navigation is wanted. The browser
    owns the URL, history, target and scrolling. There is no replacement
    navigation module, generated destination ID or custom history entry.
    Hero effects and height handling remain independent of navigation.
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
- **form_validity**: ordinary forms retain validity reflection, generated ids
  when absent, and invalid/`data-not-allowed="true"` submission blocking. The
  obsolete non-native validity polyfill remains retired.
- **form_html**: marked `[data-paste-form]` forms retain native validation and
  background submission through the shared fragment operation. When `FormData`
  or `paste.io` throws, or `paste.io` starts no
  request, the submit is not taken over: it proceeds natively and the target
  is never marked busy.
- **throttle**: the opening call owns the window. Default mode runs once at
  the end with that call's context and arguments. `runFirst` runs once at the
  start, with no trailing call. Intervening calls are discarded; reentry from
  the callback is still inside the occupied window. Idless wrappers share
  by function source plus period. Truthy explicit ids share by property-key
  coercion, including numeric/string equivalents. A timer
  registration error releases the window and propagates. Callback cleanup
  runs even if the callback throws. No synthetic synchronous-timer support. Migration: latest-argument and leading-plus-
  trailing behavior from the earlier refactor is removed.
- **animation-frame**: keep request ids opaque and cancel through `cancel()`.
  Each native asynchronous batch runs phased reads, plain callbacks, then
  phased writes. Native frame timestamps pass through unchanged, including
  zero or repeated values; no fabricated monotonic clock. Missing RAF uses a
  16 ms timer cadence with `performance.now()` (or Date). Missing cancellation still
  suppresses stale callbacks. Callback errors are reported asynchronously
  without discarding other work. Page wrappers must preserve the native
  asynchronous API contract; synchronous/throwing wrapper repair is removed.

The source itself carries these costs and contracts. Minification is optional;
no optimizer is required to remove unnecessary closures, walks or listeners.

## Why Source-Only?

This package contains **source code only**—no compiled output.
The [`paste-assetgraph`](https://github.com/PasteStack/paste-assetgraph) pipeline handles:

- SCSS → CSS compilation
- JS/CSS minification
- Dependency graph extraction
- Topological sorting
- Fingerprinting / hashing
- Manifest generation

## Runtime cost and content lifetime

Smoothscroll discovery uses weak identity membership where `WeakSet` is
available: repeated `init()` does not rescan previously bound links for each
candidate or retain removed anchors. Its native-history, easing, cancellation
and optional API contracts are unchanged. Hosts without `WeakSet` keep the
legacy membership fallback.

Sticky navigation retains original declaration state weakly where `WeakMap`
is available. A child-list observer releases detached navs from active tracking
and target observation, and restores an already-known nav when reinserted,
including its original own-position threshold. It does not discover new navs;
call `init()` for those. Without `MutationObserver`, call `init()` after content
replacement to refresh membership. Without `WeakMap`, the legacy registry
remains. Minimum-width-ineligible navs do not schedule scroll frames; resize,
load and size observation still refresh eligibility.

Autogrow initialization batches independent fields before writing their heights;
nested legacy `.autogrow` ancestors are measured after their descendants grow. Input and
legacy keyup still grow the individual field synchronously; deletion never
shrinks it. Progressive-resolution observer delivery looks up the affected host
where weak indexing is available, retaining the original scan fallback when
that facility is unavailable or refuses construction.

Image limits belong to each instance, not to the page. An image sequence admits
up to six in-flight preparations and uses a 32 MiB estimate for retained decoded
pixels per sequence. Progressive resolution permits one pending preparation per
host. Multiple active instances multiply those allowances; neither limit is a
page-wide network or native decoded-memory cap. Native request coalescing and
decode caching are browser-owned. Use authored lazy loading for offscreen image
hosts where appropriate, load only needed modules, and size many-instance pages
against their actual media. No global scheduler or URL-only preparation cache
is imposed: CORS/referrer policy, ownership and representation validation remain
part of each preparation's contract.

## Native boundary corrections

Ordinary forms keep native interactive validation and authored `novalidate` /
`formnovalidate` bypasses. Legacy validity reflection and `data-not-allowed="true"`
submission blocking remain. Background forms reserve their ancestor reply target
before constructing `FormData`, whose synchronous `formdata` event may reenter
submission. Only one request may own a target. GET and urlencoded POST normalize
filename line breaks like native form submission; multipart stays with FormData.

Multistate also supports radio-only dimensions: `data-multistate-value` panels
are optional. Native sibling CSS can supply the entire presentation while
history, defaults and state reflection still recognize each declared radio.

An invalid attribute name in an IO reply variable binding is skipped locally;
other bindings continue. There is no console message or new event for that
malformed authoring. Other DOM failures still propagate.

## Restored modules and responsibility boundaries

These modules retain their original attribute names and optional entry points,
under `paste.ui.*`. Load only the behaviors the page declares; `forForms()` in
Surface still opts into autogrow alone.

| Module | Authored contract | Responsibility |
| --- | --- | --- |
| `allowed_chars` | `data-allowed-char-expr`, `data-disallowed-char-expr`; `initialize(force)` | Filter typed characters. Native `pattern` and server validation still validate complete values. |
| `form.form_autosave` | Form `data-ui-autosave="field,field"`, `data-autosave-action`; `init(parent)` | Detect edits, schedule saves and acknowledge sent values. Applies its successful reply. |
| `imageupload` | File `data-image-upload-action`; `data-image-upload-for` pairs URI, preview and message; `bind(fieldOrForm, form)` | Upload the chosen file and reflect the returned URI. Resolution/sequence modules do not upload files. |
| `js_tooltip` | `data-ui-js-tooltip="class=html\|class=html"`; `init(parent)` | Display authored rich help on hover/focus. Use `title` for plain native help. |
| `multistate` | Named native radios with `data-multistate-key` | Reflect selection into URL/history and optional panel markers. Native `:checked`, `+` and `~` remain available without JavaScript. |
| `navigate_on_change` | Control `data-navigate-on-change="true"` | Navigate to its value on change. Ordinary destinations remain anchors. |
| `prevent_double_submit` | Submit input/button `data-prevent-double-submit="true"`; `init(parent)` | Guard native navigation, keeping the first submitter in the payload. Canceled submits remain the canceling handler's responsibility. |
| `select` | `select[data-paste-select]` followed by `[data-paste-select-value]`; `init(parent)` | Reflect the visible option label for custom CSS while native selection, focus and form behavior remain intact. Generalized from the original branded select. |
| `sortable` | `data-paste-sortable` group, `.paste-ui-sortable` blocks, `draggable="true"` slots; `bind(parent, callbacks)` | Swap slot contents, retaining block/order-field positions, node identity and listeners. |
| `update_text_on_input_change` | `data-update-variable-name`, `data-update-variable-names`; `init`, `setVariable`, `updateOutputs` | Substitute text-node placeholders. It does not interpret field values as HTML or update attributes. |

Autosave preserves the first-edit/change/blur immediate save and a fixed
ten-second window for later typing. It posts native FormData, including
successful unmonitored fields, while only the listed names trigger saves.
`autosaving` means a request is pending, `not-autosaving` means it is idle,
and `not-autosaved` means current values are not acknowledged (or the original
same-action form has not yet been acknowledged). A failure stays dirty until
another edit/change/blur retries; it does not start an endless retry loop.
Unloading the page is not a delivery guarantee.

Autosave applies the original `data.modules[name].markup` with `data-update-contents`,
and `data.variables` with `data-update-attribute`. It also accepts Surface's
`data.fragments` and `data-paste-io-reply-fragment-target` / `-bind` hooks.
Reply placement uses `paste.ui.utilities.io-html-fragment`; autosave owns the
save acknowledgment and applies replies only while its originating form is live.
Both HTTP status and `meta.code` must be 200. Original scalar variables accept strings,
numbers and booleans; Surface bindings retain their string-only contract.
When both vocabularies appear, original fragments precede Surface fragments, then
original bindings precede Surface bindings. Reply HTML is trusted server markup.

`form_validity` retains native validity reflection. `form_html` owns explicit
background form submission, while `io-html-fragment` reserves its destination
against competing fragment loads until the owned operation settles or is
superseded. `prevent_double_submit`
protects a native navigation and releases its own disabled controls on reset or
pageshow. A canceled background submission does not leave a native navigation lock.

Text updates preserve the `%(name)s` syntax and optional
`data-update-variable-default` and `data-original-value`. Only authored text
nodes are templates: attribute, script, style and textarea interpolation is
unsupported. Values such as `0` remain values; unchecked checkboxes clear their
old value. `setVariable` stages a value; `updateOutputs` applies it. Initial
native values are read at binding, and `init(parent)` discovers new markup.

Image upload requires an authored file ID and three companions inside its form:
`data-image-upload-uri`, `data-image-upload-preview`, and
`data-image-upload-message`, each with `data-image-upload-for="file-id"`.
`data-image-upload-param` overrides the multipart field name. A successful
`{meta:{code:200},data:"path"}` reply writes the hidden URI and dispatches a
bubbling native `change`; the preview combines `data-image-url-prefix` with
that path. Empty/error replies restore `data-image-upload-default-src` (or the
initial preview source). `data-image-upload-loading` marks the file and message;
`data-image-upload-error-message` carries a server rejection or default message.
`data-image-upload-timeout` declares the request deadline in decimal
milliseconds, default 30,000, `0` for none.
The optional `modules/imageupload/imageupload` stylesheet displays error/loading
messages; its silent `mixin` import supplies `paste-ui-imageupload-message()`
with a configurable loading label. Author an accessible status element and the
remaining image presentation.

Tooltip content is trusted authored markup. Its default optional stylesheet
is `modules/js_tooltip/js_tooltip`; `modules/js_tooltip/mixin` is silent and
provides `paste-ui-js-tooltip()` for a consumer-owned selector. No global body
positioning, site-specific image-upload skin or loader asset is installed by base.

## Native select appearance

`paste.ui.select` generalizes the original branded select: a real select supplies selection,
keyboard interaction and form values; an adjacent text-only mirror supplies an
optional CSS face. Load `modules/select/select.scss` for `.paste-ui-select`, or
include the silent `paste-ui-select()` mixin within your wrapper selector.

```html
<label>Region
  <span class="paste-ui-select">
    <select name="region" data-paste-select>
      <option value="ct">Connecticut</option>
      <option value="ny">New York</option>
    </select>
    <span data-paste-select-value aria-hidden="true"></span>
  </span>
</label>
```

The native control stays visible without JavaScript and in forced-colors mode.
The enhancement reads the visible option label, never changes the submitted
value, and reflects completed native resets. Whitespace between siblings is
allowed. Multiple selects, listboxes and missing mirrors stay native.
`init(parent)` includes a root select and can refresh authored option/value
changes without duplicating listeners. Call it after inserting new controls.
Programmatic assignment needs change or init; there are no observers or polling.
Surface's Select template emits this contract, with caller-authored
option/optgroup content.

## Verification browser matrix

`bash tests/run-all-checks.sh` runs the Node suite, real assetgraph Sass checks
with readable and minified CSS, native consistency/responsibility checks,
source/minified select checks, and the complete Java Elements and marquee
suites in Chromium, Firefox and WebKit.
CI provisions paste-assetgraph 0.3.1 and Playwright 1.41.0, with Chromium
151.0.7922.34, Firefox 121 and WebKit 17.4. Logs and run-scoped fixture identities
are retained even when a check fails. Local runners require the documented
runtime paths; they do not install dependencies themselves.

This matrix is evidence for the named builds. Sites targeting other versions
should validate their authored CSS and native navigation there.

## License

Apache License, Version 2.0. See `LICENSE` and `NOTICE`.

## Ordered playback

ImageSequence.playback defaults to SequencePlayback.Direct, preserving immediate
scroll ownership. SequencePlayback.Queued(framesPerSecond = 30) emits
data-sequence-playback="queued" and data-sequence-playback-fps (integer 1..120).
Hand-authored queued markup may omit the rate for 30 fps. Invalid modes or rates
are rejected; a rate requires queued mode.

Queued playback retains a running intro and then advances through the scroll
range from the displayed completed intro endpoint to the latest scroll destination.
Without a completed intro, travel starts at the authored scroll start. Different
intro and scroll endpoints are connected by every intervening catalog frame. It advances
at most one catalog index per presentation pass and waits for readiness.
Input updates the remaining destination; it does not accumulate obsolete input
events. Playback continues after input stops, reverses from its current cursor,
and rests when the destination is reached. A pending frame wakes on resource
completion rather than an idle frame loop. Intro readiness remains bounded;
an intro unable to finish retires at its declared duration plus 15 seconds.
Starting after navigation or skipping an intro preserves the existing startup
and history rules. Reduced motion retains the static baseline. A hidden
document retires its intro and suspends queued travel until fresh measurement.

This policy changes presentation only. Native scrolling and authored layout
remain in charge of visibility; leaving a section does not force it to stay
onscreen. Resource limits, resolution selection and readiness gates remain
in force. Failed frames may prevent an ordered path completing; the last usable
image remains. Queue completion does not imply decoded-cache eviction.

## Form family module names

Use `paste.ui.form.form_validity` for native validity reflection,
`paste.ui.form.form_apply` for JSON submissions, and `paste.ui.form.form_html`
for HTML reply replacement. Apply and HTML include validity as a dependency.
Choose one submission owner per form. `FormSubmission` and its emitted HTML
remain unchanged: `Native`, `Apply`, and `Html` describe behavior, not file paths.

Load the canonical modules directly. The former top-level form, apply,
formhtml and autosave JavaScript entries have been removed; no compatibility
includes remain. Autosave is `paste.ui.form.form_autosave`, at
`modules/form/form_autosave/form_autosave.js`, with its own trigger and request
lifetime. Its request deadline defaults to 30 seconds, overridden per form by
`data-autosave-timeout`. Forms still require explicit
autosave declarations; loading the module does not opt ordinary forms in.

Existing classes, data attributes and `paste.ui.formhtml:failed` keep their
spelling. The general form stylesheet and field mixins remain in `modules/form`.
Import Apply styles from `modules/form/form_apply/form_apply.scss` or its silent
`_mixin.scss`; the former `modules/apply` forwarding styles have been removed.
