# Paste Elements

**Paste Elements** is the core UI kit for the Paste ecosystem.

YUI-style modules: each element bundles its **JS behavior + SCSS styling** together.
Works standalone for basic HTML sites, or with `paste-surface-*` for templated apps.

## Directory Structure

```
paste-elements/
├── base/                       # Global variables and reset
│   ├── _variables.scss         # Colors, breakpoints, z-index
│   └── _base.scss              # Reset/normalize
│
├── modules/                    # UI modules (JS + SCSS together)
│   ├── heroscroll/
│   │   ├── heroscroll.js       # Parallax scroll behavior
│   │   ├── heroscroll.scss     # Hero styles
│   │   └── _variables.scss     # $paste-hero-min-height, etc.
│   ├── stickynav/
│   │   ├── stickynav.js
│   │   ├── stickynav.scss
│   │   └── _variables.scss
│   ├── autogrow/
│   │   ├── autogrow.js         # Auto-resize textareas
│   │   └── autogrow.scss
│   ├── smoothscroll/
│   │   └── smoothscroll.js     # Smooth anchor scrolling
│   └── throttle/
│       └── throttle.js         # Utility (JS only)
│
├── structure/                  # Page structure (SCSS only)
│   ├── grid/
│   │   ├── grid.scss           # 12-column grid
│   │   └── _variables.scss     # $paste-grid-columns, $paste-grid-gutter
│   ├── layout/
│   │   ├── layout.scss         # Header, footer, sidebar
│   │   └── _variables.scss     # $paste-header-height, etc.
│   ├── typography/
│   │   ├── typography.scss     # Headings, paragraphs, links
│   │   └── _variables.scss     # $paste-font-family, $paste-font-size-*
│   └── spacing/
│       ├── spacing.scss        # Margin/padding utilities
│       └── _variables.scss     # $paste-spacers
│
└── index.scss                  # Import all (or import individually)
```

## Usage

### Basic HTML Site (no surface)

```bash
npm install @pastestack/elements
```

**main.scss:**
```scss
// Import just what you need
@import '@pastestack/elements/base/variables';
@import '@pastestack/elements/structure/grid/grid';
@import '@pastestack/elements/modules/heroscroll/heroscroll';

// Override variables BEFORE importing
$paste-grid-columns: 16;
$paste-hero-min-height: 80vh;
```

**index.html:**
```html
<section data-paste-hero="main" data-paste-parallax="true">
  <h1>Welcome</h1>
</section>

<script src="/paste/heroscroll,smoothscroll.min.js" defer></script>
```

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
| smoothscroll | ✓ | - | Smooth anchor scrolling |
| multistate | ✓ | ✓ | Hash-driven UI state (`#key:value`) for tabs and radio inputs |
| marquee | ✓ | ✓ | One semantic list with optional CSS-driven continuous motion |
| throttle | ✓ | - | Event throttling utility (`paste.ui.utilities.throttle`) |
| animation-frame | ✓ | - | Batches DOM writes into the next animation frame (`paste.ui.utilities.animation-frame`) |

## Marquee

`paste.ui.marquee` enhances one semantic list with optional continuous CSS motion. Each original
item exists once: no clones, reordering, animation-frame loop, or dependency on Surface. Load its
SCSS/CSS and JavaScript through paste-assetgraph, or use the standalone example.

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
cycle; the Element measures only on initialization, resize, or explicit refresh. The duration is
positive finite seconds per cycle, not a refresh-rate-dependent pixel step.

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

`paste.ui.marquee.init(root)` returns an idempotent controller with `refresh()`, `pause()`,
`resume()`, and `dispose()`. Call `refresh()` after changing items or configuration. Disposal
releases observers and subscriptions, restores owned attributes/styles, and never removes caller
content. Roots with `data-paste-marquee` initialize automatically on load, including when the
module is loaded after the document. No global prototype is patched.

Standalone development checks (Node's built-in test runner; no npm dependencies):

```sh
node --test tests/
PASTE_CORE_JS=/path/to/paste/src/js node tests/build-marquee-example.cjs /path/to/paste-assetgraph
python3 -m http.server 8077 --bind 127.0.0.1 --directory target/marquee-example
```

The example build merges `examples/marquee.conf` with the core module location from
`PASTE_CORE_JS` (the `src/js` directory of a `paste` release or checkout) into
`target/marquee-example.conf`, then emits a self-contained static page with compiled CSS/JS. It
fails with that instruction when the variable is unset rather than guessing a path. Serve the
result with any static server; Scala, Surface, and a JAM server are not required. Missing required
compiled modules fail the example build rather than yielding an unstyled demo. Browser checks
must verify off-screen cycle endpoints, pause/resume, live reduced-motion changes, no-JS behavior,
resize coverage, and unchanged original-node identity. These checks do not by themselves establish
smooth physical display presentation; retain browser-specific profiling for reported jitter.

The real-browser runner reuses an existing Playwright Java 1.41 runtime (playwright, driver,
driver-bundle, and gson jars) and installed Chromium/WebKit browsers; it downloads nothing:

```sh
PLAYWRIGHT_JAVA_CLASSPATH="$EXISTING_PLAYWRIGHT_CLASSPATH" tests/run-marquee-browser-checks.sh
```

`MARQUEE_URL` defaults to the example server above. `PLAYWRIGHT_BROWSERS_PATH` selects an installed
cache; `MARQUEE_CHROMIUM_EXECUTABLE` optionally selects an installed Chromium-family executable.
The actual browser version, check results, and geometry evidence are written under
`target/browser-checks/`. A missing browser is an error, not a skipped pass.

## Structure

| Module | Description | Key Variables |
|--------|-------------|---------------|
| grid | 12-column responsive grid | `$paste-grid-columns`, `$paste-grid-gutter` |
| layout | Page structure (header, footer) | `$paste-header-height`, `$paste-footer-padding-y` |
| typography | Headings, paragraphs, links | `$paste-font-family-*`, `$paste-font-size-*` |
| spacing | Margin/padding utilities | `$paste-spacers`, `$paste-section-padding-y` |

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
