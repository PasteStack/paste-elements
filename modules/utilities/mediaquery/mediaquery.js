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

/*jslint browser:true sub:true */
/*globals paste */

/**
 * @module paste/ui/utilities/mediaquery
 *
 * The MediaQueryList binding implementation paste elements share. Core's
 * event Subscription accepts only Nodes and window, so it would rebind a
 * MediaQueryList to the document; this utility is that narrow,
 * documented exception, held in one place instead of one copy per
 * module.
 *
 * observe(query, handler) evaluates a media query and, when the platform
 * can report changes, calls handler(matches) on each change. It returns
 * a record:
 *
 * - observed: true only when matchMedia exists, answered with a boolean
 *   `matches`, and accepted a change listener (addEventListener, or the
 *   legacy addListener when the modern method is missing or refuses).
 *   A `matches` read that throws is no answer: the query is unobserved.
 * - matches: the answer at observation time; null when not observed.
 * - dispose(): removes the listener through the same API that added it.
 *   Safe to call more than once; a removal the platform refuses is
 *   ignored, because the record no longer reacts either way.
 *
 * The shared policy for motion: a reduced-motion preference that cannot
 * be observed counts as reduced. motionReduced(record) answers that, and
 * for an observed record it reads the query's live answer, so a
 * preference that changes without reporting the change is honoured the
 * next time a caller asks. A live read that throws or answers a
 * non-boolean keeps the last known answer — the one at observation or
 * the latest change reported.
 *
 * watchResolution(handler) watches the current device pixel ratio with a
 * `(resolution: Ndppx)` query and re-arms at the new ratio after each
 * change, calling handler() once per change. It returns {dispose()}. A
 * platform that cannot observe the query gets no watch; callers still
 * re-read the ratio on resize.
 *
 * matchMedia is captured once at definition, so a page script replacing
 * it later cannot change which facility an observation uses.
 */

paste['define'](
    'paste.ui.utilities.mediaquery',
    [],
    function (mediaquery) {
        'use strict';

        var $w = window,
            $matchMedia = typeof $w['matchMedia'] === 'function' ? $w['matchMedia'] : null,
            UNOBSERVED_DISPOSE = function () {
                return undefined;
            },
            unobserved = function () {
                return {observed: false, matches: null, dispose: UNOBSERVED_DISPOSE};
            },
            // A list's answer: a boolean, or null when the read throws
            // or answers anything else.
            answerOf = function (list) {
                var matches;
                try {
                    matches = list['matches'];
                } catch (unreadable) {
                    return null;
                }
                return typeof matches === 'boolean' ? matches : null;
            },
            evaluate = function (query) {
                var list = null,
                    matches;
                if ($matchMedia === null) {
                    return null;
                }
                try {
                    list = $matchMedia.call($w, query);
                } catch (refused) {
                    return null;
                }
                matches = list ? answerOf(list) : null;
                if (matches === null) {
                    return null;
                }
                // Keep the validated answer across listener registration:
                // a wrapped host can make later reads unavailable.
                return {list: list, matches: matches};
            },
            observe = function (query, handler) {
                var evaluated = evaluate(query),
                    list = evaluated ? evaluated.list : null,
                    modern = false,
                    disposed = false,
                    listener,
                    record;
                if (list === null) {
                    return unobserved();
                }
                listener = function (change) {
                    var matches = change && typeof change['matches'] === 'boolean' ?
                            change['matches'] : answerOf(list);
                    if (matches === null) {
                        matches = record['matches'];
                    }
                    if (!disposed) {
                        record['matches'] = matches;
                        handler(matches);
                    }
                };
                if (typeof list['addEventListener'] === 'function') {
                    try {
                        list['addEventListener']('change', listener);
                        modern = true;
                    } catch (modernRefused) {
                        modern = false;
                    }
                }
                if (!modern) {
                    if (typeof list['addListener'] !== 'function') {
                        return unobserved();
                    }
                    try {
                        list['addListener'](listener);
                    } catch (legacyRefused) {
                        return unobserved();
                    }
                }
                record = {
                    observed: true,
                    matches: evaluated.matches,
                    live: function () {
                        var current = answerOf(list);
                        return current === null ? record['matches'] : current;
                    },
                    dispose: function () {
                        if (disposed) {
                            return;
                        }
                        disposed = true;
                        try {
                            if (modern) {
                                list['removeEventListener']('change', listener);
                            } else {
                                list['removeListener'](listener);
                            }
                        } catch (removalRefused) {
                            // The listener is already inert: `disposed`
                            // stops it reacting whatever the platform did.
                            disposed = true;
                        }
                    }
                };
                return record;
            },
            motionReduced = function (record) {
                if (!record || !record['observed']) {
                    return true;
                }
                return typeof record['live'] === 'function' ?
                        record['live']() === true : record['matches'] === true;
            },
            watchResolution = function (handler) {
                var current = null,
                    stopped = false,
                    arm = function () {
                        var ratio = $w['devicePixelRatio'];
                        if (stopped) {
                            return;
                        }
                        if (typeof ratio !== 'number' || !(ratio > 0)) {
                            ratio = 1;
                        }
                        current = observe('(resolution: ' + ratio + 'dppx)', function () {
                            if (current) {
                                current['dispose']();
                            }
                            current = null;
                            arm();
                            handler();
                        });
                        if (!current['observed']) {
                            current = null;
                        }
                    };
                arm();
                return {
                    dispose: function () {
                        stopped = true;
                        if (current) {
                            current['dispose']();
                        }
                        current = null;
                    }
                };
            };

        mediaquery['observe'] = observe;
        mediaquery['motionReduced'] = motionReduced;
        mediaquery['watchResolution'] = watchResolution;

        return mediaquery;
    }
);
