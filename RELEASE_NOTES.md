# paste-elements v0.6.0

## Unreleased: Apply, separate HTML loading and restored Carousel

- `paste.ui.form.form_validity` now owns ordinary native validity reflection and blocking.
  Load `paste.ui.form.form_apply` for `form.paste-ui-apply` JSON submission, or
  `paste.ui.form.form_html` for `form.paste-ui-formhtml` HTML replies. The latter
  also accepts the previous `data-paste-form` declaration during migration.
  Its busy/failure classes and failure event now belong to `formhtml`.
  Existing background form consumers must change their module dependency;
  loading `paste.ui.form.form_validity` alone no longer transports their submissions.
- Restored the original separate `paste.ui.lazy_loader` APIs. The owning page
  requests visible content after its own state changes; no automatic observer
  or scroll listener was added.
- Restored Carousel's discrete paging, controls, indicators,
  counter, named instances, events and cycling. Native buttons, pause/reduced
  motion, accurate variable-width paging and complete disposal fix concrete
  usability and lifetime gaps. See the matching Surface Carousel contract.
- Native form-member access no longer fails when a control has a name such as
  `elements` or `addEventListener`. The shared `form-dom` utility contains that
  boundary without reserving field names or changing core.
- Added an application-owned external-library wrapper example that uses core
  URL dependencies to gate readiness. No extra loader or Surface element.

Historical entries below retain their original release context. They are not
the current module ownership map.

## Unreleased: restored modules and autosave ownership

Restored the selected enhancements under `paste.ui.*`. Autosave owns its
request and reply handling. The standalone `paste.ui.io-reply-fragment-envelope`
client module and its public `apply` API are retired; remove its script/dependency
when migrating to autosave. Surface's serializer and existing wire format remain
accepted. Historical entries below describe the earlier release, not the current
client module inventory.


**Date:** 2026-10-22

## Added

- `paste.ui.imagesequence`: declarative scroll- or time-driven image
  sequences on a frame host, with adaptive manifests resolved against the
  element's rendered size and BFCache-safe restore behaviour.
- `paste.ui.progressiveresolution`: standalone images that upgrade their
  `src`/`srcset` representation as layout settles, with per-descriptor
  intrinsic sizes and lazy reveal inside nested scrollers.
- `paste.ui.scrollscrub`: scrub-driven playhead mapping between declared
  window bounds, shared by the sequence elements.
- Shared helpers moved under `modules/utilities/` — animation-frame,
  throttle, imageresolution, mediaquery and scrollrange — so elements
  compose them rather than duplicating timing and media logic.

## Changed

- Elements that repaint shared style properties now record their own
  last-written value and priority, restoring or removing only while they
  still own it; a newer writer is never clobbered and `!important` is
  preserved.
- Observer callbacks treat records as untrusted input: entry lengths are
  bounded and each record's target is validated against the module's own
  index before use.
- Teardown is terminal — queued and deferred work cannot fire after
  teardown, and a failing cleanup in one root cannot strand its siblings.
- Where MutationObserver, child observation or a media query cannot be
  observed, elements stand down to their authored static presentation.
- The marquee binds at definition time, and the sticky nav measures its
  threshold from a flow sentinel instead of geometry reads.

## Removed

- The `animation-frame` and `throttle` top-level module directories;
  both now live under `modules/utilities/`.

# paste-elements v0.5.0

**Date:** 2026-09-30

## Added

- `paste.ui.form.form_validity`: `data-paste-form-timeout` sets the intercepted
  request's deadline in decimal milliseconds (default 30000; the literal
  `0` opts out; malformed values fall back rather than silently
  disabling the deadline), so a stalled request can no longer hold the
  busy state forever.
- `paste.ui.form.form_validity`: every outcome after transmission dispatches a
  bubbling, cancelable `paste.ui.form:failed` event whose
  `detail.reason` is `"error"`, `"timeout"`, `"abort"` or `"response"`;
  a listener calling `preventDefault()` owns the failure UX.

## Changed

- `paste.ui.form.form_validity`: without a listener the form resubmits natively only
  where a replay cannot duplicate the submission — a `get`, or a form
  carrying `data-paste-form-idempotent` — and any other failure appends
  and focuses a `paste-ui-form-failure` `role="alert"` notice preserving
  every entered value. A request never transmitted still resubmits
  natively unconditionally.

# paste-elements v0.4.0

**Date:** 2026-09-23

## Added

- `paste.ui.form.form_validity`: a `form[data-paste-form]` inside an IO reply fragment
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
