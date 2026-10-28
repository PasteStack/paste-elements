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
 * Smooth same-document anchors. Plain links push immediately; legacy marked
 * containers delegate clicks and push at completion. Both use 500ms cubic
 * movement without native fragment navigation or synthetic hashchange.
 * init() discovers links. scrollTo(element, duration) moves only;
 * scrollTo(id, offset) retains the legacy completion-history contract.
 * The smoothscroll event accepts {newURL, verticalOffset, updateHash}.
 * Wheel input cancels pending motion/history. Reduced motion lands immediately.
 * No focus reassignment. Modified clicks and foreign destinations stay native.
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
            command,
            stop = function () {
                generation += 1;
                if (pending !== null) {
                    cancel(pending);
                    pending = null;
                }
                if (wheel) {
                    wheel.dispose();
                    oldWheel.dispose();
                    wheel = null;
                    oldWheel = null;
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
            navOffset = function () {
                var nav = dom['querySelector']('.paste-ui-section-nav');
                return nav ? nav.getBoundingClientRect().height : 0;
            },
            move = function (target, duration, offset, hash) {
                var start = dom['getScrollTop'](),
                    left = $w.pageXOffset || 0,
                    end,
                    started = null,
                    token,
                    reduced,
                    animate;
                if (!target || !target.getBoundingClientRect) {
                    return;
                }
                stop();
                token = generation;
                end = target.getBoundingClientRect().top + start - offset;
                reduced = !$w.matchMedia || $w.matchMedia('(prefers-reduced-motion: reduce)').matches;
                if (!(duration > 0) || reduced) {
                    $w.scrollTo({left: left, top: end, behavior: 'instant'});
                    if (hash) {
                        push(hash, {});
                    }
                    return;
                }
                animate = function (time) {
                    var progress,
                        eased;
                    if (token !== generation) {
                        return;
                    }
                    pending = null;
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
                        if (hash) {
                            push(hash, {});
                        }
                    }
                };
                wheel = new Subscription('wheel', $w, stop);
                oldWheel = new Subscription('mousewheel', $w, stop);
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
                offset = Number(data['verticalOffset']) || 0;
                move(target, 500, offset, update ? '#' + id : null);
            },
            click = function (e) {
                var anchor = event['getEventTarget'](e),
                    target,
                    context,
                    declared,
                    base;
                if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || e.button) {
                    return;
                }
                while (anchor && anchor.nodeName !== 'A') {
                    anchor = anchor.parentNode;
                }
                if (!anchor || anchor.hasAttribute('download') ||
                        (anchor.closest && anchor.closest('.paste-ui-section-nav-disclosure'))) {
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
                declared = anchor.closest && anchor.closest('[data-paste-smoothscroll], .paste-ui-section-nav');
                move(target, 500, declared ? navOffset() : 0, declared ? anchor.hash : null);
                if (!declared) {
                    push(anchor.hash, null);
                }
            },
            init = function () {
                var declared = dom['get']('a[href*="#"], [data-paste-smoothscroll], .paste-ui-section-nav', true) || [],
                    index = declared.length,
                    element,
                    found;
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
                move(resolve(target), 500, value === undefined ? navOffset() : Number(value) || 0, '#' + target);
            } else {
                move(target, value === undefined ? 500 : value, 0, null);
            }
        };
        command = new event['Event']($w, 'smoothscroll');
        command['subscribe'](legacy);
        if ($d.readyState === 'loading') {
            bind('DOMContentLoaded', $d, init, null, 1);
        } else {
            init();
        }
        return smoothscroll;
    }
);
