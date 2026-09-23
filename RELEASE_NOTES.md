# paste-elements v0.4.0

**Date:** 2026-09-23

## Added

- `paste.ui.form`: a `form[data-paste-form]` inside an IO reply fragment
  target submits through `paste.io` in the background and the returned markup
  replaces the target's content. The request is the one the browser would have
  sent — the submitting button's `formaction`/`formmethod`/`formenctype`/
  `formtarget` overrides, the fields in document order, the resolved enctype —
  so the form behaves the same without JavaScript. Only same-origin HTML,
  including after a redirect, is placed; anything else resubmits natively so
  the server's full page reports the outcome. Submissions the Element cannot
  reproduce (image buttons, `text/plain` posts, other browsing contexts,
  browsers missing a required capability) are left to the browser.
- `paste.ui.io-reply-fragment-envelope`: applies an IO reply fragment envelope
  reply — markup into named targets, string variables onto bound attributes —
  only on success.

## Changed

- `paste.ui.marquee` no longer requires `paste.event`, and resize
  notifications refresh on the next animation frame, so a refresh that changes
  the observed boxes no longer triggers a ResizeObserver loop.

# paste-elements v0.3.0

**Date:** 2026-09-22

## Added

- `paste.ui.marquee`: one semantic list with optional CSS-driven continuous motion.
  Every original item exists once — no clones, no reordering, no animation-frame
  loop, no Surface dependency. Missing capabilities, reduced motion, insufficient
  repeat coverage, interactive content, or focus inside the list leave a readable
  static list, and the pause control stays hidden until it is functional.
- Behaviour checks on Node's built-in test runner (no dependencies), a standalone
  example builder, and a real-browser runner that reuses an installed Playwright
  runtime.
- `paste.ui.scrollspy`, `paste.ui.multistate`, and
  `paste.ui.utilities.animation-frame`; utility modules moved under the
  `paste.ui.utilities.*` namespace.
- `paste.ui.sectionnav` disclosure support: the URL fragment is the
  browser-owned state, `:target` decides panel visibility, and picking a
  section link closes the panel with no menu-specific JavaScript. Item
  anchors carry `paste-ui-section-nav-link` as a styling hook, and
  `data-spy-touch` opts a nav into scrollspy on touch devices.

## Fixed

- Focus inside a marquee list no longer becomes a pause the reader never asked for:
  focus re-evaluates eligibility and motion resumes once focus leaves.
- The module's document-ready listener removes itself after it fires.

## Changed

- The standalone example build takes the core module location from `PASTE_CORE_JS`
  and fails with that instruction when it is unset, instead of assuming an adjacent
  checkout.
- CI runs the module checks and syntax-checks every module, rather than three of them.

## Licensing

- Licensed under the Apache License, Version 2.0 (`LICENSE`, `NOTICE.md`).

# paste-elements v0.1.0

**Date:** 2026-02-07

## Initial Release

- Restructured to YUI-style module layout (`base/`, `structure/`, `modules/`)
- Ported mature heroscroll implementation from PasteStack
- Fixed `pageResizeSub` / `isBound()` check in `dispatchPageResize`
- Includes modules: heroscroll, stickynav, smoothscroll, autogrow, throttle
- Includes structure: grid, layout, spacing, typography
- Includes base styles and variables
