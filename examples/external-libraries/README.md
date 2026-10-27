# Named external libraries

Copy `jquery.js` into the app's scanned JS source and provide its pinned
`/vendor/jquery.js` asset. The wrapper is app policy: Elements neither ships
jQuery nor selects its version or CDN. Give different libraries their own
named wrapper using the same existing Paste contract.

The build graph reads named `@module`/`@requires` declarations. A URL goes in
the runtime dependency array, not in a build `@requires` declaration. Request
the wrapper with `page.jam(js = Seq("libs.jquery"))`, or request a module like
the included consumer whose named build and runtime dependencies include it.
Surface's existing `Jam(js = Seq("libs.jquery"))` also expresses that request;
no new Surface element is needed. Include the wrapper in the build's scanned
sources; an unknown JAM name remains a build/lookup error.

The consumer factory receives jQuery only after the script load completes.
Defining an empty wrapper and calling `paste.require(url)` inside its factory,
as the old wrapper did, does not give that readiness guarantee to the
wrapper's dependents. A failed load does not run consumers with a fake value;
Paste core owns its existing retry/error behavior.

The URL loader does not declare arbitrary script attributes. A tracker needing
configuration attributes, such as the current RMS Umami script, still uses
its authored script element. This example does not replace that integration.
