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

/*jslint browser:true plusplus:true sub:true */
/*globals paste */

/**
 * Marks each [data-paste-sticky-nav] active after a declared target.
 * The attribute's nonempty value is a CSS selector; an empty value uses
 * the first [data-paste-sticky-target]. An absent target uses the initial nav position. Invalid selectors or self targets
 * leave the nav alone. A target must remain a stable in-flow box when
 * the nav's class changes. For ordinary sticking at the nav's own slot,
 * use CSS position: sticky; this module does not reconstruct that slot.
 *
 * Each valid nav receives paste-ui-sticky and, at or below its target's
 * bottom, paste-ui-sticky-active. CSS owns positioning and presentation.
 * data-sticky-min-width on that nav accepts whole nonnegative pixels;
 * the nav stays inactive at or below that width. Touch is not excluded.
 * Links, URLs and history remain native. No root class, custom events,
 * content moves. Child-list observation retires detached navs and restores
 * already-known navs on reinsertion; newly authored navs still need init().
 * Without that observation, init() refreshes membership. init() discovers navs; updateSticky() refreshes synchronously.
 *
 * One shared phased frame batches measurements before class changes.
 * Scroll, resize, page load and optional ResizeObserver reports request
 * it. Scroll measures the declared boxes directly, so a stale cached
 * threshold cannot survive a layout change until the next resize.
 *
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/utilities/animation-frame
 * @module paste/ui/stickynav
 */
paste['define'](
    'paste.ui.stickynav',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.utilities.animation-frame'
    ],
    function (stickynav, dom, event, animation_frame) {
        'use strict';

        var $w = window,
            $d = document,
            $Number = Number,
            Observer = $w['ResizeObserver'],
            Changes = $w['MutationObserver'],
            known = typeof $w['WeakMap'] === 'function' ? new $w['WeakMap']() : null,
            bind = event['bind'],
            requestPhased = animation_frame['requestPhased'],
            getViewportWidth = dom['getViewportWidth'],
            WHOLE_NUMBER = /^[0-9]+$/,
            BASE_CLASS = 'paste-ui-sticky',
            ACTIVE_CLASS = 'paste-ui-sticky-active',
            navs = [],
            retiredCount = 0,
            pending = false,
            eligible = false,
            changes,
            observer,
            listening = false,
            read = function () {
                var width = getViewportWidth(),
                    index = navs.length,
                    nav;
                eligible = false;
                while (index--) {
                    nav = navs[index];
                    eligible = eligible || width > nav.minWidth;
                    nav.next = width > nav.minWidth &&
                        (nav.target ? nav.target.getClientRects().length > 0 &&
                            nav.target.getBoundingClientRect().bottom <= 0 :
                                dom['getScrollTop']() >= nav.offsetTop);
                }
            },
            write = function () {
                var index = navs.length,
                    nav;
                while (index--) {
                    nav = navs[index];
                    if (nav.active === null) {
                        nav.element.classList.add(BASE_CLASS);
                    }
                    if (nav.next !== nav.active) {
                        if (nav.next) {
                            nav.element.classList.add(ACTIVE_CLASS);
                        } else {
                            nav.element.classList.remove(ACTIVE_CLASS);
                        }
                        nav.active = nav.next;
                    }
                }
                pending = false;
            },
            schedule = function () {
                if (!pending) {
                    pending = true;
                    requestPhased(read, write);
                }
            },
            onScroll = function () {
                if (eligible) {
                    schedule();
                }
            },
            // Only active navs are enumerated. Weak membership preserves a
            // caller-retained nav's initial threshold across detach/reinsert.
            refreshTargets = function () {
                var index = navs.length;
                if (observer) {
                    observer.disconnect();
                    observer.observe($d.documentElement);
                    while (index--) {
                        if (navs[index].target) {
                            observer.observe(navs[index].target);
                        }
                    }
                }
            },
            retireDetached = function () {
                var index = navs.length,
                    changed = false,
                    nav;
                while (index--) {
                    nav = navs[index];
                    if (!$d.documentElement.contains(nav.element)) {
                        nav.attached = false;
                        retiredCount += 1;
                        navs.splice(index, 1);
                        changed = true;
                    }
                }
                if (!navs.length) {
                    eligible = false;
                }
                return changed;
            },
            restore = function (element) {
                var nav = known.get(element);
                if (nav && !nav.attached && $d.documentElement.contains(element)) {
                    nav.attached = true;
                    retiredCount -= 1;
                    nav.active = null;
                    navs.push(nav);
                    return true;
                }
                return false;
            },
            changedTree = function (records) {
                var index = records.length,
                    added,
                    remaining,
                    node,
                    descendants,
                    descendant,
                    removed = false,
                    changed = false;
                while (index--) {
                    removed = removed || records[index].removedNodes.length > 0;
                }
                if (removed) {
                    changed = retireDetached();
                }
                index = retiredCount ? records.length : 0;
                while (index-- && retiredCount) {
                    added = records[index].addedNodes;
                    remaining = added.length;
                    while (remaining-- && retiredCount) {
                        node = added[remaining];
                        if (node.nodeType === 1) {
                            changed = restore(node) || changed;
                            if (retiredCount && node.firstElementChild) {
                                descendants = node.querySelectorAll('*');
                                descendant = descendants.length;
                                while (descendant-- && retiredCount) {
                                    changed = restore(descendants[descendant]) || changed;
                                }
                            }
                        }
                    }
                }
                if (changed) {
                    refreshTargets();
                    if (navs.length) {
                        schedule();
                    }
                }
            },
            init = function () {
                var elements = dom['get']('[data-paste-sticky-nav]', true) || [],
                    remaining = elements.length,
                    fallback = remaining ? dom['querySelector']('[data-paste-sticky-target]') : null,
                    element,
                    selector,
                    target,
                    minWidth,
                    existing,
                    found,
                    nav,
                    retired = known && retireDetached(),
                    valid;
                while (remaining--) {
                    element = elements[remaining];
                    existing = known ? 0 : navs.length;
                    found = known ? known.has(element) : false;
                    if (found) {
                        retired = restore(element) || retired;
                    }
                    while (existing--) {
                        if (navs[existing].element === element) {
                            found = true;
                            break;
                        }
                    }
                    if (!found) {
                        selector = element.getAttribute('data-paste-sticky-nav');
                        target = fallback;
                        valid = true;
                        if (selector) {
                            try {
                                target = dom['querySelector'](selector);
                            } catch (invalidSelector) {
                                valid = false;
                            }
                        }
                        if (valid && target !== element) {
                            minWidth = element.getAttribute('data-sticky-min-width');
                            nav = {
                                element: element,
                                target: target,
                                offsetTop: target ? 0 : element.getBoundingClientRect().top + dom['getScrollTop'](),
                                minWidth: minWidth !== null && WHOLE_NUMBER.test(minWidth) ? $Number(minWidth) : 0,
                                active: null,
                                next: false,
                                attached: true
                            };
                            navs.push(nav);
                            if (known) {
                                known.set(element, nav);
                            }
                            if (observer && target) {
                                observer.observe(target);
                            }
                        }
                    }
                }
                if (retired) {
                    refreshTargets();
                }
                if (navs.length) {
                    if (!listening) {
                        listening = true;
                        bind('scroll', $w, onScroll);
                        bind('resize', $w, schedule);
                        if ($d.readyState !== 'complete') {
                            bind('load', $w, schedule, null, 1);
                        }
                        if (Observer) {
                            observer = new Observer(schedule);
                            refreshTargets();
                        }
                        if (known && Changes) {
                            changes = new Changes(changedTree);
                            changes.observe($d, {childList: true, subtree: true});
                        }
                    }
                    schedule();
                }
            };

        stickynav['init'] = init;
        stickynav['updateSticky'] = function () {
            var scheduled = pending;
            read();
            write();
            pending = scheduled;
        };
        if ($d.readyState === 'loading') {
            bind('DOMContentLoaded', $d, init, null, 1);
        } else {
            init();
        }
        return stickynav;
    }
);
