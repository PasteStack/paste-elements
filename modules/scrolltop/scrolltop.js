/*!
 * Copyright (c) 2017–present Tomshley LLC
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     https://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/*jslint browser:true plusplus:true sub:true unparam:true */
/*globals paste */

/**
 * Declared anchors to the page the visitor is already on navigate to the
 * empty fragment instead of reloading. The browser performs the scroll to
 * the top and records the history entry; the entry's address is then
 * rewritten without the "#". Traversal restores the scroll position the
 * click left behind. The rewritten entry's state is "paste.ui.scrolltop";
 * a repeat activation replaces that entry, as a native "#" link does.
 *
 * Declare it with the attribute alone. The href must name the current
 * address's path and query, with no fragment or an empty one. Nothing
 * binds without a declaration when the module is defined, or without
 * history.replaceState. Modified and non-primary clicks, other browsing
 * contexts, download and ping links and any non-empty fragment remain
 * native.
 *
 * @example
 *     <a href="/" data-paste-scrolltop>
 *         <img src="/logo.svg" alt="Home">
 *     </a>
 *
 * @requires paste/event
 * @module paste/ui/scrolltop
 */
paste['define']('paste.ui.scrolltop', ['paste.event'], function (scrolltop, event) {
    'use strict';

    var $w = window,
        $doc = document,
        $location = $w.location,
        $history = $w.history,
        ATTRIBUTE = 'data-paste-scrolltop',
        // Marks the entries this module rewrote, so a repeat activation
        // replaces its own entry the way a native "#" link does.
        ENTRY = 'paste.ui.scrolltop',
        // The keywords that name this browsing context; a top-level window
        // is its own top and its own parent.
        CURRENT = $w.top === $w ? /^_(self|top|parent)$/i : /^_self$/i,
        baseTarget,

        onClick = function (e) {
            var anchor = e.target,
                context,
                address,
                index;
            if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
                return;
            }
            while (anchor && anchor.nodeName !== 'A') {
                anchor = anchor.parentNode;
            }
            // A download or a ping is work the author asked of the native
            // click; the same-document navigation would drop it.
            if (!anchor || !anchor.hasAttribute(ATTRIBUTE) ||
                    anchor.hasAttribute('download') || anchor.hasAttribute('ping')) {
                return;
            }
            context = anchor.getAttribute('target') || baseTarget;
            if (context && !CURRENT.test(context) && context !== $w.name) {
                return;
            }
            // hash reads '' for both no fragment and an empty one; an anchor
            // without an href reads protocol ':' and stops here.
            if (anchor.hash || anchor.protocol !== $location.protocol || anchor.host !== $location.host ||
                    anchor.pathname !== $location.pathname || anchor.search !== $location.search ||
                    anchor.username || anchor.password) {
                return;
            }
            // The address itself up to its first "#", not the anchor's search:
            // search reads '' for an empty query too, and dropping that "?"
            // would leave the document instead of navigating within it. An
            // address already ending in "#" then navigates to itself, which
            // replaces its entry as a native "#" link does.
            address = $location.href;
            index = address.indexOf('#');
            if (index !== -1) {
                address = address.slice(0, index);
            }
            e.preventDefault();
            if ($history.state === ENTRY) {
                $location.replace(address + '#');
            } else {
                $location.href = address + '#';
            }
            try {
                $history.replaceState(ENTRY, '', address);
            } catch (ignore) {
                // A refused rewrite leaves the "…#" address; the click still
                // landed at the top.
            }
        };

    if ($history && $history.replaceState && $doc.querySelector('a[' + ATTRIBUTE + ']')) {
        baseTarget = $doc.querySelector('base[target]');
        baseTarget = baseTarget && baseTarget.getAttribute('target');
        event['bind']('click', $doc, onClick);
    }
});
