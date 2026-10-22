# paste-elements Roadmap

Deferred work the current modules name but do not implement:

- **Vector rungs at any URL** — `imagesequence` and
  `progressiveresolution` treat a rung as a vector, exempt from the
  decoded-size check, only when its URL has a `.svg` or `.svgz` path or is
  an `image/svg+xml` data URL. An SVG served from an extensionless URL is
  held to its declared size, and Chromium reports a viewBox-only SVG as
  300×150, so that rung is refused and the host keeps its base image
  (rendering is unaffected). A per-rung media type in the descriptor
  grammar (`utilities/imageresolution`) would let a declaration mark it.
