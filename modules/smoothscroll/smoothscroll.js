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
 * Smooth same-document anchors inside a declared container
 * ([data-paste-smoothscroll], a section nav that declares it included): the
 * container delegates its links' clicks, which push history at completion
 * after 500ms cubic movement instead of the native fragment scroll, with no
 * synthetic hashchange; the push runs from the position the movement
 * started from, so Back returns there, and a fragment the address already
 * names is not pushed again. Any other link stays native. Discovery runs at
 * define, or at DOMContentLoaded while the document is loading; init()
 * repeats it. scrollTo(element, duration) moves only; scrollTo(id, offset)
 * retains the legacy completion-history contract. The smoothscroll event
 * accepts {newURL, verticalOffset, updateHash}.
 * Without an explicit offset, movement aims at the clearance native fragment
 * navigation keeps, the target's scroll-margin-top and the root's
 * scroll-padding-top (a percentage is of the viewport), or, when it writes
 * the fragment and the page declares neither, at the section nav's
 * clearance. Wheel input stops the motion where it is and cancels pending
 * history; a native navigation, or one that moves the document, supersedes
 * it. Reduced motion lands immediately. Once the fragment is written, a
 * same-address replace moves focus, the sequential focus navigation starting
 * point and :target as native fragment navigation does, and its own scroll
 * to the fragment is the landing, a :target-only scroll-margin-top
 * included; an explicit offset is held over it. Chromium and WebKit fire
 * popstate for it, and no hashchange fires. Focus the visitor moved during
 * the motion stays, and :target then does not follow.
 * Modified clicks and foreign destinations stay native, as do a disclosure
 * section nav's toggles and a section chosen from its open panel, whose
 * navigation closes it; its section links are the module's while the URL
 * does not target the panel.
 *
 * Native motion: when the root's computed --paste-smoothscroll-motion is
 * "native" at define, no link is discovered or bound and clicks stay
 * native — CSS owns motion, clearance and reduced motion through
 * scroll-behavior, scroll-margin-top and scroll-padding-top; the page
 * enables smooth scroll-behavior only under prefers-reduced-motion:
 * no-preference. scrollTo(id) and the event navigate to the fragment
 * natively; a target the address already names, scrollTo(element) and
 * updateHash false use scrollIntoView. Duration and offsets do not apply;
 * missing targets, including ones not yet parsed, are ignored. Nothing
 * waits for the document: the root's style is read at define, so link the
 * stylesheet that sets the property ahead of the script. Only a stylesheet
 * linked in the markup, with no onload swap, reliably holds back the inline
 * and parser-blocking scripts after it while it loads, not async, defer or
 * module ones.
 *
 * @example
 *     :root { --paste-smoothscroll-motion: native; }
 *     section[id] { scroll-margin-top: 4rem; }
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/smoothscroll
 */
paste['define'](
    'paste.ui.smoothscroll',
    ['paste.dom', 'paste.event', 'paste.ui.utilities.animation-frame'],
    function (smoothscroll, dom, event, animation_frame) {
        'use strict';

        var $w = window,
            $d = document,
            $history = $w.history,
            $hasOwn = Object['prototype']['hasOwnProperty'],
            bind = event['bind'],
            Subscription = event['Event']['Subscription'],
            request = animation_frame['request'],
            cancel = animation_frame['cancel'],
            links = typeof $w['WeakSet'] === 'function' ? new $w['WeakSet']() : null,
            legacyLinks = links ? null : [],
            pending = null,
            generation = 0,
            wheel = null,
            oldWheel = null,
            popped = null,
            // Where a motion whose history is still pending started, so a
            // movement that replaces it pushes from there.
            origin = null,
            probe = null,
            // The root's computed style, live, held once at define; a host
            // without it keeps the default motion.
            rootStyle = typeof $w.getComputedStyle === 'function' ? $w.getComputedStyle($d.documentElement) : null,
            nativeMotion = !!rootStyle && rootStyle.getPropertyValue('--paste-smoothscroll-motion').trim() === 'native',
            PERCENT = /%$/,
            command,
            stop = function () {
                generation += 1;
                origin = null;
                if (pending !== null) {
                    cancel(pending);
                    pending = null;
                }
                if (wheel) {
                    wheel.dispose();
                    oldWheel.dispose();
                    popped.dispose();
                    wheel = null;
                    oldWheel = null;
                    popped = null;
                }
            },
            push = function (hash, state) {
                if ($history && $history.pushState) {
                    try {
                        $history.pushState(state, '', hash);
                    } catch (refused) {
                        return;
                    }
                }
            },
            resolve = function (id) {
                var target = $d.getElementById(id);
                if (!target) {
                    try {
                        target = $d.getElementById(decodeURIComponent(id));
                    } catch (malformed) {
                        return null;
                    }
                }
                return target;
            },
            // A fragment written through history leaves the sequential focus
            // navigation starting point and :target behind. Once the address
            // names the target, a same-address replace runs the platform's own
            // fragment steps for both, with no entry and no hashchange. Its
            // scroll to the fragment is the landing unless a top is held: an
            // explicit offset. Native runs those steps at activation; focus
            // the visitor has moved since then is theirs, so the settle
            // stands down.
            settle = function (target, left, top, focused) {
                if ($d.activeElement !== focused || resolve($w.location.hash.slice(1)) !== target) {
                    return;
                }
                try {
                    $w.location.replace($w.location.href);
                } catch (refused) {
                    return;
                }
                if (top !== null) {
                    $w.scrollTo({left: left, top: top, behavior: 'instant'});
                }
            },
            // Native motion: the platform's fragment navigation owns motion,
            // the focus starting point and the history entry. Setting the
            // fragment the address already carries does not scroll in every
            // engine, so a target that is already current is only scrolled
            // into view.
            land = function (target, id) {
                if (!target) {
                    return;
                }
                if (id !== null && resolve($w.location.hash.slice(1)) !== target) {
                    $w.location.hash = id;
                } else if (target.scrollIntoView) {
                    target.scrollIntoView();
                }
            },
            navOffset = function () {
                var nav = dom['querySelector']('.paste-ui-section-nav');
                return nav ? nav.getBoundingClientRect().height : 0;
            },
            // The section nav's own :target clearance: the root's
            // --paste-ui-section-nav-clearance resolved as a length when the
            // root sets it, else the measured nav, which the mixin defaults to.
            sectionClearance = function () {
                var clear;
                if (!rootStyle || !rootStyle.getPropertyValue('--paste-ui-section-nav-clearance').trim()) {
                    return navOffset();
                }
                if (!probe) {
                    probe = $d.createElement('div');
                    probe.style.cssText = 'position:absolute;visibility:hidden;scroll-margin-top:var(--paste-ui-section-nav-clearance)';
                }
                $d.body.appendChild(probe);
                clear = parseFloat($w.getComputedStyle(probe).scrollMarginTop) || 0;
                $d.body.removeChild(probe);
                return clear;
            },
            // Where the motion aims: the clearance the platform's own fragment
            // navigation keeps, the target's scroll-margin-top and the root's
            // scroll-padding-top, read per movement as media queries change
            // them; a percentage padding is of the viewport. A margin that
            // applies only under :target is not visible before the settle, so
            // a movement that writes the fragment aims at the section nav's
            // clearance when the page declares neither, and the settle lands
            // it.
            clearance = function (target, fallback) {
                var clear = 0,
                    padding;
                if (rootStyle) {
                    padding = rootStyle.scrollPaddingTop;
                    clear = (parseFloat($w.getComputedStyle(target).scrollMarginTop) || 0) +
                            (parseFloat(padding) || 0) * (PERCENT.test(padding) ? $d.documentElement.clientHeight / 100 : 1);
                }
                return clear || (fallback ? sectionClearance() : 0);
            },
            // offset is a held number of pixels, or whether the clearance
            // aims at the section nav's when the page declares none.
            move = function (target, duration, offset, hash) {
                var start = dom['getScrollTop'](),
                    left = $w.pageXOffset || 0,
                    end,
                    started = null,
                    token,
                    reduced,
                    held = typeof offset === 'number',
                    // A navigation that moves the document meanwhile, such as
                    // placed fragment markup, stops the motion where it is.
                    address = $w.location.href.split('#')[0],
                    focused = $d.activeElement,
                    from = origin !== null ? origin : start,
                    arrive,
                    animate;
                if (!target || !target.getBoundingClientRect) {
                    return;
                }
                stop();
                token = generation;
                end = target.getBoundingClientRect().top + start - (held ? offset : clearance(target, offset));
                reduced = !$w.matchMedia || $w.matchMedia('(prefers-reduced-motion: reduce)').matches;
                // The push records the scroll position on the entry it leaves,
                // so it runs from where the movement started, as a native
                // click's does, and Back returns there; nothing paints between
                // the two instant scrolls. An address that already names the
                // target is not pushed again: the settle replaces its entry,
                // as a native same-fragment navigation does.
                arrive = function () {
                    if (hash) {
                        if (resolve($w.location.hash.slice(1)) !== target) {
                            $w.scrollTo({left: left, top: from, behavior: 'instant'});
                            push(hash, {});
                            $w.scrollTo({left: left, top: end, behavior: 'instant'});
                        }
                        settle(target, left, held ? end : null, focused);
                    }
                };
                if (!(duration > 0) || reduced) {
                    $w.scrollTo({left: left, top: end, behavior: 'instant'});
                    arrive();
                    return;
                }
                animate = function (time) {
                    var progress,
                        eased;
                    if (token !== generation) {
                        return;
                    }
                    pending = null;
                    if ($w.location.href.split('#')[0] !== address) {
                        stop();
                        return;
                    }
                    if (started === null) {
                        started = time;
                    }
                    progress = Math.min((time - started) / duration, 1);
                    eased = progress < 0.5 ? 4 * progress * progress * progress :
                            (progress - 1) * (2 * progress - 2) * (2 * progress - 2) + 1;
                    $w.scrollTo({left: left, top: start + (end - start) * eased, behavior: 'instant'});
                    if (progress < 1) {
                        pending = request(animate);
                    } else {
                        stop();
                        arrive();
                    }
                };
                // Wheel input stops the motion where it is, and a navigation
                // the platform performs meanwhile supersedes it.
                wheel = new Subscription('wheel', $w, stop);
                oldWheel = new Subscription('mousewheel', $w, stop);
                popped = new Subscription('popstate', $w, stop);
                origin = hash ? from : null;
                pending = request(animate);
            },
            legacy = function (unused, data) {
                var id = data ? data['newURL'] : $w.location.hash.slice(1),
                    target,
                    update,
                    offset;
                if (typeof id !== 'string') {
                    return;
                }
                data = data || {};
                target = resolve(id);
                update = !$hasOwn['call'](data, 'updateHash') || data['updateHash'] === true ||
                        (typeof data['updateHash'] === 'string' && data['updateHash'].toLowerCase() === 'true');
                if (nativeMotion) {
                    land(target, update ? id : null);
                    return;
                }
                offset = data['verticalOffset'] !== undefined ? Number(data['verticalOffset']) || 0 : update;
                move(target, 500, offset, update ? '#' + id : null);
            },
            click = function (e) {
                var anchor = event['getEventTarget'](e),
                    target,
                    context,
                    base;
                if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) {
                    return;
                }
                while (anchor && anchor.nodeName !== 'A') {
                    anchor = anchor.parentNode;
                }
                // The browser owns disclosure: the panel's own toggles, and a
                // section chosen from the open panel, whose navigation closes it
                // and releases its scroll lock.
                if (!anchor || anchor.hasAttribute('download') || (anchor.closest &&
                        anchor.closest('.paste-ui-section-nav-toggle, .paste-ui-section-nav-panel:target'))) {
                    return;
                }
                base = $d.querySelector('base[target]');
                context = anchor.hasAttribute('target') ? anchor.getAttribute('target') :
                        (base ? base.getAttribute('target') : '');
                if (context && context.toLowerCase() !== '_self' && context !== $w.name) {
                    return;
                }
                if (anchor.protocol !== $w.location.protocol || anchor.host !== $w.location.host ||
                        anchor.pathname !== $w.location.pathname || anchor.search !== $w.location.search ||
                        !anchor.hash || anchor.hash.length < 2) {
                    return;
                }
                target = resolve(anchor.hash.slice(1));
                if (!target) {
                    return;
                }
                e.preventDefault();
                move(target, 500, true, anchor.hash);
            },
            init = function () {
                var declared,
                    index,
                    element,
                    found;
                // CSS owns motion and clearance: native clicks scroll and push
                // history as authored, so no link needs discovery or a listener.
                if (nativeMotion) {
                    return;
                }
                // Only a declared container takes its links' clicks; any other
                // link stays the platform's.
                declared = dom['get']('[data-paste-smoothscroll]', true) || [];
                index = declared.length;
                while (index--) {
                    element = declared[index];
                    found = links ? links.has(element) : legacyLinks.indexOf(element) >= 0;
                    if (!found) {
                        if (links) {
                            links.add(element);
                        } else {
                            legacyLinks.push(element);
                        }
                        bind('click', element, click);
                    }
                }
            };

        smoothscroll['init'] = init;
        smoothscroll['scrollTo'] = function (target, value) {
            if (typeof target === 'string') {
                if (nativeMotion) {
                    land(resolve(target), target);
                    return;
                }
                move(resolve(target), 500, value === undefined ? true : Number(value) || 0, '#' + target);
            } else {
                if (nativeMotion) {
                    land(target, null);
                    return;
                }
                move(target, value === undefined ? 500 : value, false, null);
            }
        };
        command = new event['Event']($w, 'smoothscroll');
        command['subscribe'](legacy);
        if (!nativeMotion && $d.readyState === 'loading') {
            bind('DOMContentLoaded', $d, init, null, 1);
        } else {
            init();
        }
        return smoothscroll;
    }
);
