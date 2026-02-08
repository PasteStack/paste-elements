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
| autogrow | ✓ | ✓ | Auto-resize textareas |
| smoothscroll | ✓ | - | Smooth anchor scrolling |
| throttle | ✓ | - | Event throttling utility |

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