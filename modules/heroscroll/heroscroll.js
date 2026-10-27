/*jslint browser:true plusplus:true sub:true unparam:true */
/*globals paste */

/**
 * Hero scroll parallax effect.
 *
 * Markup: elements carrying the paste-ui-hero class, each with an
 * optional .paste-ui-hero-image and .paste-ui-hero-content child.
 *
 *   force-full-height        (attribute on the image) — the image's
 *                            inline height follows the viewport height.
 *                            This is geometry, not motion: it is applied
 *                            at bind and re-applied on resize, whatever
 *                            the reduced-motion preference. On touch
 *                            devices it is re-applied only when the
 *                            viewport width or the screen orientation
 *                            changes — a height-only resize there is the
 *                            browser toolbar showing or hiding, and
 *                            following it would shift the content below
 *                            the hero mid-scroll.
 *   data-hero-image-fixed    (image) — no parallax background position.
 *   data-hero-image-fade     (image) — the image fades as the hero
 *                            leaves the viewport.
 *   data-hero-min-opacity    (image) — a plain decimal from 0 to 1:
 *                            digits with an optional fraction ('0.25',
 *                            '.25', '1.'), read untrimmed. The fade
 *                            never writes an opacity below it (default
 *                            0). Any other spelling, or a value above 1,
 *                            is the default.
 *
 * Motion effects — the content fade, the image fade and the background
 * parallax — are owned inline writes: the first write captures the
 * authored inline value and priority, and releasing the effect writes
 * them back unless another writer replaced the declaration since. Every
 * owned value is written in a canonical form (opacity to three decimal
 * places, the background offset in whole pixels) that the style
 * interface serializes unchanged, so ownership is judged against the
 * value written; the declaration is read back only when an effect is
 * released. A content box in the band where no fade rule applies
 * (entering from the bottom fold) has its owned opacity released, so the
 * authored value shows rather than a stale fade.
 *
 * Parallax base offset: the image's computed background-position is read
 * once, at the first measure, before any parallax write. A single-layer value whose vertical component is in
 * px is the base the parallax offsets from; a percentage or keyword
 * vertical component, or a multi-layer value, contributes no base offset
 * (0) — the module never reads a percentage as pixels. The parallax
 * write itself is one layer: '50% <offset>px', with
 * background-attachment fixed, written once when the parallax takes
 * ownership. A frame whose rounded offset is unchanged writes nothing.
 *
 * Reduced motion: the effects run only while the
 * prefers-reduced-motion preference is observable and not 'reduce', as
 * paste.ui.utilities.mediaquery reports it — an unobservable preference
 * counts as reduced. The preference is kept from the change listener and
 * re-read once per frame, never per scroll event. While the effects
 * stand down no motion frame is
 * armed at all; a resize still arms one frame for the geometry work
 * above. The frame is one phased animation-frame request: its reads run
 * before any module writes. A resize that changes the full-height
 * override writes it in that frame and measures the bounds it moved in
 * the next frame's read phase, never by reading back its own write.
 *
 * Late layout: the hero bounds are measured at bind and re-measured
 * whenever the document body changes size — an image or a web font
 * arriving above a hero, or content added to the page — through one
 * ResizeObserver on the body, and once more when the document's own
 * load completes, since a resource landing inside a box whose size is
 * fixed moves a hero without resizing the body. Either input only
 * marks the bounds stale and arms the frame, as a resize does; a
 * module defined after load needs no load pass. Without these, a
 * hero's content could keep the opacity of the position it had before
 * the page settled.
 *
 * Touch devices (paste.has) get the touch class and no motion effects:
 * no scroll listener and no preference observation. A resize listener
 * is bound on touch devices only when a hero image carries
 * force-full-height, for that geometry alone.
 *
 * Loaded marker: the paste-ui-heroscroll-loaded class is written to the
 * element dom.getDocumentBody() returns (the root element in standards
 * mode) and to body whenever the module defines, whether or not the page
 * has heroes — pages gate presentation on it.
 *
 * Navigation belongs to authored anchors and the browser. This module
 * binds no click handler and never changes the URL or session history.
 *
 * @requires paste/util
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/has
 * @requires paste/ui/utilities/animation-frame
 * @requires paste/ui/utilities/mediaquery
 * @requires polyfills/getcomputedstyle
 * @module paste/ui/heroscroll
 */
paste['define'](
    'paste.ui.heroscroll',
    [
        'paste.util',
        'paste.dom',
        'paste.event',
        'paste.has',
        'paste.ui.utilities.animation-frame',
        'paste.ui.utilities.mediaquery',
        'polyfills.getcomputedstyle'
    ],
    function (heroscroll, util, dom, event, has, animation_frame, mediaquery, getComputedStylePolyfill) {
        'use strict';

        var $w = window,
            $style = $w['getComputedStyle'],
            $d = document,
            $math = Math,
            $min = $math.min,
            $max = $math.max,
            $round = $math.round,
            $parseFloat = parseFloat,
            $String = String,
            $Number = Number,
            $keys = Object['keys'],
            NativeResizeObserver = $w['ResizeObserver'],
            Subscription = event['Event']['Subscription'],
            requestPhased = animation_frame['requestPhased'],
            boundsFromElement = dom['Bounds']['fromElement'],
            html = dom['getDocumentBody'](),
            body = $d.getElementsByTagName('body')[0],
            bodyStyle = $d.body.style,
            OVERRIDE_IMAGE_HEIGHT_FLAG = 'force-full-height',
            LOADED_CLASS = 'paste-ui-heroscroll-loaded',
            HERO_CLASS = 'paste-ui-hero',
            HERO_TOUCH_CLASS = HERO_CLASS + '-touch',
            HERO_IMAGE_CLASS = HERO_CLASS + '-image',
            HERO_CONTENT_CLASS = HERO_CLASS + '-content',
            DECIMAL = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/,
            PIXELS = /^(-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+))px$/,
            BACKGROUND_MULTIPLIER = 0.3,
            touchSupported = !!has['touch'],
            backgroundSizeSupported = typeof bodyStyle['backgroundSize'] === 'string',
            opacitySupported = typeof bodyStyle['opacity'] === 'string',
            opacityProperty = opacitySupported ? 'opacity' : 'filter',

            heroList = null,
            motion = null,
            // The preference as the change listener and the last frame
            // left it: scroll input reads this, never the query.
            motionOn = false,
            framePending = false,
            // Resize input performs no geometry work of its own: it
            // marks the cache stale and arms the owned frame, so a burst
            // of resize events recalibrates once.
            geometryDirty = false,
            // Whether any hero declares the full-height override, fixed
            // at discovery.
            fullHeight = false,
            // The full-height override last written, so an unchanged
            // viewport height writes nothing.
            writtenHeight,
            // The viewport width and screen orientation the override
            // was last written for: on touch, only a change to either
            // re-applies it.
            writtenShape,
            // The hero bounds wait on a read phase: set when geometry
            // moved, cleared once a read phase with no height write
            // still to land has measured.
            measurePending = false,
            // The read phase's snapshot, carried to the same frame's
            // write phase.
            passHeight,
            passMotion = false,
            hasEffects = false,
            passScrollTop = 0,
            passOffsetTop = 0,
            passViewport = 0,
            // Assigned after the frame phases it arms.
            requestHeroFrame,

            // Listeners that live as long as the page.
            pageSubscriptions = [],
            // The body's size watch, page-lifetime like the listeners.
            bodyObserver = null,
            // A plain decimal from 0 to 1, or the default — no falsy-zero,
            // no NaN, and no floor above full opacity.
            minOpacityAttribute = function (element) {
                var text = element.getAttribute('data-hero-min-opacity'),
                    value = text !== null && DECIMAL.test(text) ? $Number(text) : 0;
                return value <= 1 ? value : 0;
            },

            /*
             * GEOMETRY
             */
            // The base offset the parallax starts from: the px vertical
            // component of a single-layer computed position, else 0.
            backgroundBaseY = function (heroImage) {
                var text = $String($style(heroImage).getPropertyValue('background-position') || ''),
                    parts,
                    match;
                if (text.indexOf(',') !== -1) {
                    return 0;
                }
                parts = text.split(' ');
                match = PIXELS.exec(parts[1] || '');
                return match ? $Number(match[1]) : 0;
            },
            // Authored margins/offsets are read once per measure, never
            // per scroll — re-reading a computed style on every scroll
            // event forces layout in the input path.
            measureContentVisualOffsets = function (heroContent) {
                var heroContentStyle;
                if (!heroContent) {
                    return {top : 0, bottom : 0};
                }
                heroContentStyle = $style(heroContent);
                return {
                    top : ($parseFloat(heroContentStyle.getPropertyValue('margin-top')) || 0) +
                          ($parseFloat(heroContentStyle.getPropertyValue('top')) || 0),
                    bottom : ($parseFloat(heroContentStyle.getPropertyValue('margin-bottom')) || 0) +
                             ($parseFloat(heroContentStyle.getPropertyValue('bottom')) || 0)
                };
            },
            // The content box's visible band is measure geometry: the
            // element's cached top plus its authored top offsets, and
            // the cached height less both ends. Deriving it where the
            // rects are read leaves the frame pass consuming numbers.
            deriveVisualBounds = function (hero) {
                var offsets = hero.contentVisualOffsets,
                    contentBounds = hero.contentBounds;
                if (contentBounds && offsets) {
                    hero.contentVisualTop = contentBounds['top'] + offsets.top;
                    hero.contentVisualHeight = contentBounds['height'] - offsets.top - offsets.bottom;
                }
            },
            // Geometry recalibration batches writes before reads: the
            // full-height overrides land for every hero first, then one
            // pass takes every measurement — interleaving the two per
            // hero would pay a reflow per hero. The height is read by
            // the caller; this is writes only.
            // The viewport width and screen orientation, as one key.
            viewportShape = function () {
                var screen = $w['screen'],
                    orientation = screen ? screen['orientation'] : null,
                    angle = $w['orientation'];
                return dom['getViewportWidth']() + ' ' +
                    (orientation && typeof orientation['type'] === 'string' ? orientation['type'] :
                            (typeof angle === 'number' ? angle : ''));
            },
            applyHeroImageHeights = function (heroes, viewportHeight) {
                var index = heroes.length,
                    image,
                    text = viewportHeight + 'px';
                while (index--) {
                    image = heroes[index].image;
                    if (image && image.hasAttribute(OVERRIDE_IMAGE_HEIGHT_FLAG)) {
                        image.style.height = text;
                    }
                }
                writtenHeight = viewportHeight;
            },
            measureHeroes = function (heroes) {
                var index = heroes.length,
                    hero,
                    image;
                while (index--) {
                    hero = heroes[index];
                    image = hero.image;
                    hero.bounds = boundsFromElement(hero.element);
                    // The base is read once, before the first parallax
                    // write: afterwards the computed position is the
                    // module's own write, never the authored base.
                    if (image && !hero.imageFixed && hero.backgroundY === undefined) {
                        hero.backgroundY = backgroundSizeSupported ? backgroundBaseY(image) : 0;
                    }
                    if (image && hero.content) {
                        hero.contentBounds = boundsFromElement(hero.content);
                        hero.contentVisualOffsets = measureContentVisualOffsets(hero.content);
                        deriveVisualBounds(hero);
                    }
                }
            },

            // Discovery only: records and classes, no geometry — the
            // caller batches the height writes and the measurements.
            discoverHeroes = function () {
                var elements = dom['get']('.' + HERO_CLASS, true) || [],
                    remaining = elements.length,
                    index = 0,
                    element,
                    image,
                    imageUrl,
                    hero,
                    heroes = [];
                while (remaining--) {
                    element = elements[index];
                    if (touchSupported) {
                        dom['addCssClass'](element, HERO_TOUCH_CLASS);
                    }
                    image = dom['querySelector']('.' + HERO_IMAGE_CLASS, element);
                    if (image && !backgroundSizeSupported) {
                        imageUrl = $style(image).getPropertyValue('background-image');
                        if (util['stringStartsWith'](imageUrl, 'url(') && util['stringEndsWith'](imageUrl, ')')) {
                            imageUrl = imageUrl.slice(4, -1).replace(/['"]/g, '');
                            image.style.backgroundImage = 'none';
                            image.style.filter = "progid:DXImageTransform.Microsoft.AlphaImageLoader(src='" + imageUrl + "', sizingMethod='scale');";
                        }
                    }
                    hero = {
                        element : element,
                        bounds : null,
                        image : image,
                        ownedStyles : {content : {}, image : {}},
                        imageFixed : !!(image && image.hasAttribute('data-hero-image-fixed')),
                        imageFade : !!(image && image.hasAttribute('data-hero-image-fade')),
                        imageMinOpacity : image ? minOpacityAttribute(image) : 0,
                        backgroundY : undefined,
                        content : dom['querySelector']('.' + HERO_CONTENT_CLASS, element),
                        contentBounds : null,
                        contentVisualOffsets : null,
                        contentVisualTop : 0,
                        contentVisualHeight : 0,
                        writtenContentOpacity : undefined,
                        writtenImageOpacity : undefined,
                        writtenBackgroundTop : undefined
                    };
                    if (image && (!hero.imageFixed || hero.imageFade || hero.content)) {
                        hasEffects = true;
                    }
                    heroes[index] = hero;
                    index += 1;
                }
                return heroes;
            },

            /*
             * OWNED STYLES
             */
            // A preference read that throws counts as reduced.
            readMotion = function () {
                try {
                    return motion !== null && !mediaquery['motionReduced'](motion);
                } catch (unreadable) {
                    return false;
                }
            },
            // A property the module never wrote is not its to restore:
            // the first owned write captures the inline value and
            // priority it replaced, and restore writes back exactly
            // those captured records. Every write goes through
            // setProperty with no priority, in a canonical text the
            // style interface serializes unchanged — the record keeps
            // that text as the ownership proof, with no readback.
            writeOwnedStyle = function (element, owned, property, text) {
                var style = element['style'],
                    record = owned[property];
                if (record === undefined) {
                    record = owned[property] = {
                        value : style['getPropertyValue'](property),
                        priority : style['getPropertyPriority'](property),
                        written : undefined
                    };
                }
                style['setProperty'](property, text, '');
                record.written = text;
            },
            // The captured baseline returns only while the declaration
            // is still the one the module wrote — a newer writer's value
            // and priority are never overwritten. The record leaves
            // either way: a later effect pass recaptures whatever
            // baseline is current then.
            releaseOwnedStyle = function (element, owned, property) {
                var record = owned[property],
                    style = element['style'];
                if (record === undefined) {
                    return;
                }
                delete owned[property];
                if (style['getPropertyValue'](property) === record.written &&
                        style['getPropertyPriority'](property) === '') {
                    style['setProperty'](property, record.value, record.priority);
                }
            },
            restoreOwnedStyles = function (element, owned) {
                var properties,
                    propertiesLength;
                if (!element || !owned) {
                    return;
                }
                properties = $keys(owned);
                propertiesLength = properties.length;
                while (propertiesLength--) {
                    releaseOwnedStyle(element, owned, properties[propertiesLength]);
                }
            },
            restoreHeroPresentation = function () {
                var heroes = heroList || [],
                    index = heroes.length,
                    hero;
                while (index--) {
                    hero = heroes[index];
                    restoreOwnedStyles(hero.content, hero.ownedStyles.content);
                    restoreOwnedStyles(hero.image, hero.ownedStyles.image);
                    // The written-value memory is presentation state as
                    // well — a motion pass after a restore must prove its
                    // effect values again.
                    hero.writtenContentOpacity = undefined;
                    hero.writtenImageOpacity = undefined;
                    hero.writtenBackgroundTop = undefined;
                }
            },
            // Opacity is written to three decimal places: the canonical
            // text compares equal to its own serialization.
            canonicalOpacity = function (value) {
                return $round(value * 1000) / 1000;
            },
            writeOpacity = function (element, owned, value) {
                writeOwnedStyle(element, owned, opacityProperty, opacitySupported
                    ? $String(value)
                    : 'alpha(opacity=' + $round(value * 100) + ')');
            },

            /*
             * FRAME
             */
            // One owned frame carries all pending work: input only arms
            // it, so high-frequency input cannot queue a write per event.
            // It is one phased request. The read phase takes every
            // measurement the frame needs before any module writes:
            // the full-height target, the hero bounds when geometry
            // moved, and the scroll position the motion pass consumes.
            // A full-height override that changes lands in the write
            // phase, so the bounds it moves are measured in the next
            // frame's read phase rather than read back after the write.
            readFrame = function () {
                var height,
                    shape,
                    changedShape;
                framePending = false;
                passHeight = undefined;
                if (geometryDirty) {
                    geometryDirty = false;
                    // Measurements feed only the motion pass, which a
                    // touch device never runs.
                    measurePending = !touchSupported && hasEffects;
                    if (fullHeight) {
                        height = dom['getViewportHeight']();
                        // On touch, a height-only change is the toolbar
                        // showing or hiding, not a new viewport: only a
                        // new width or orientation re-applies.
                        changedShape = true;
                        if (touchSupported) {
                            shape = viewportShape();
                            changedShape = shape !== writtenShape;
                            writtenShape = shape;
                        }
                        if (height !== writtenHeight && changedShape) {
                            passHeight = height;
                        }
                    }
                }
                if (measurePending && passHeight === undefined) {
                    measurePending = false;
                    measureHeroes(heroList);
                }
                motionOn = readMotion();
                passMotion = motionOn;
                if (passMotion) {
                    passScrollTop = dom['getScrollTop']();
                    passOffsetTop = heroList[0].bounds['top'];
                    passViewport = dom['getViewportHeight']();
                }
            },
            // The write phase, after every module's reads: the
            // full-height override, then — while motion is allowed —
            // the motion writes from the read phase's snapshot.
            writeFrame = function () {
                var heroes = heroList,
                    heroIndex,
                    hero,
                    bounds,
                    scrollTop = passScrollTop,
                    offsetTop = passOffsetTop,
                    availableSpace = passViewport,
                    heroTop,
                    heroBottom,
                    contentTop,
                    contentBottom,
                    contentOpacity,
                    imageOpacity,
                    multiplier,
                    targetBackgroundTop;
                if (passHeight !== undefined) {
                    applyHeroImageHeights(heroes, passHeight);
                    passHeight = undefined;
                    // The moved bounds are the next frame's first read.
                    requestHeroFrame();
                }
                if (!passMotion) {
                    return;
                }
                passMotion = false;

                // Countdown traversal — each hero's writes are
                // independent, so reverse order is safe.
                heroIndex = heroes.length;
                while (heroIndex--) {
                    hero = heroes[heroIndex];
                    bounds = hero.bounds;
                    heroTop = bounds['top'] - scrollTop;
                    heroBottom = heroTop + bounds['height'];

                    // A hero the viewport cannot show keeps its last
                    // presentation — every write below is invisible
                    // while it is out of band.
                    if (heroBottom > 0 && heroTop < availableSpace) {
                        if (hero.content && hero.image) {
                            contentTop = hero.contentVisualTop - scrollTop;
                            contentBottom = hero.contentVisualTop + hero.contentVisualHeight - scrollTop;
                            contentOpacity = undefined;
                            if (contentTop > availableSpace) {
                                // below the fold
                                contentOpacity = 0;
                            } else if (contentBottom <= availableSpace && contentTop >= offsetTop) {
                                // in view
                                contentOpacity = 1;
                            } else if (contentTop < offsetTop && heroBottom >= offsetTop) {
                                // leaving at the top
                                contentOpacity = canonicalOpacity($max(0,
                                    1 - ((offsetTop - contentTop) / hero.contentVisualHeight)));
                            } else if (heroBottom < offsetTop) {
                                // above the top
                                contentOpacity = 0;
                            }
                            if (contentOpacity === undefined) {
                                // Entering from the bottom fold no rule
                                // claims a value: the owned fade is
                                // released so the authored opacity
                                // shows instead of a stale 0.
                                if (hero.writtenContentOpacity !== undefined) {
                                    releaseOwnedStyle(hero.content, hero.ownedStyles.content, opacityProperty);
                                    hero.writtenContentOpacity = undefined;
                                }
                            } else if (contentOpacity !== hero.writtenContentOpacity) {
                                writeOpacity(hero.content, hero.ownedStyles.content, contentOpacity);
                                hero.writtenContentOpacity = contentOpacity;
                            }
                        }

                        // The fade floors at the declared minimum: a
                        // jump past it still lands the floor.
                        if (hero.imageFade) {
                            imageOpacity = canonicalOpacity($max(hero.imageMinOpacity,
                                $min(1, $max(heroBottom / availableSpace, 0))));
                            if (imageOpacity !== hero.writtenImageOpacity) {
                                writeOpacity(hero.image, hero.ownedStyles.image, imageOpacity);
                                hero.writtenImageOpacity = imageOpacity;
                            }
                        }

                        if (backgroundSizeSupported && hero.image && !hero.imageFixed) {
                            targetBackgroundTop = heroTop;
                            if (targetBackgroundTop - offsetTop > availableSpace) {
                                multiplier = 1;
                            } else {
                                targetBackgroundTop = heroBottom - availableSpace;
                                if (targetBackgroundTop <= 1 && targetBackgroundTop >= 0) {
                                    targetBackgroundTop = 1;
                                } else if (targetBackgroundTop <= 0 && targetBackgroundTop >= -1) {
                                    targetBackgroundTop = -1;
                                }
                                // The multiplier's clamp has equal lower
                                // and upper bounds, so whatever the
                                // ratio, the clamped value is the bound.
                                multiplier = BACKGROUND_MULTIPLIER;
                            }
                            targetBackgroundTop = (targetBackgroundTop * multiplier) + hero.backgroundY;
                            if (targetBackgroundTop > scrollTop + heroTop) {
                                targetBackgroundTop = scrollTop + heroTop;
                            }
                            targetBackgroundTop = $round(targetBackgroundTop);
                            // An unchanged offset writes nothing; the
                            // attachment is written once, when the
                            // parallax takes ownership.
                            if (targetBackgroundTop !== hero.writtenBackgroundTop) {
                                if (hero.writtenBackgroundTop === undefined) {
                                    writeOwnedStyle(hero.image, hero.ownedStyles.image, 'background-attachment', 'fixed');
                                }
                                writeOwnedStyle(hero.image, hero.ownedStyles.image, 'background-position',
                                    '50% ' + targetBackgroundTop + 'px');
                                hero.writtenBackgroundTop = targetBackgroundTop;
                            }
                        }
                    }
                }
            },
            pageResizeHandler = function () {
                geometryDirty = true;
                requestHeroFrame();
            },
            onReducedMotionChange = function () {
                motionOn = readMotion();
                if (motionOn) {
                    requestHeroFrame();
                } else {
                    // The motion effects are this module's writes —
                    // when the preference lands, what the stylesheet
                    // authored must be what remains.
                    restoreHeroPresentation();
                }
            },
            anyFullHeight = function (heroes) {
                var index = heroes.length,
                    image;
                while (index--) {
                    image = heroes[index].image;
                    if (image && image.hasAttribute(OVERRIDE_IMAGE_HEIGHT_FLAG)) {
                        return true;
                    }
                }
                return false;
            },

            init = function () {
                // The loaded marker is the page's, not the feature's:
                // pages gate presentation on it with or without heroes.
                html.classList.add(LOADED_CLASS);
                body.classList.add(LOADED_CLASS);

                heroList = discoverHeroes();

                // No hero markup means no feature: nothing subscribes
                // and nothing measures.
                if (!heroList.length) {
                    return;
                }

                fullHeight = anyFullHeight(heroList);
                if (fullHeight) {
                    applyHeroImageHeights(heroList, dom['getViewportHeight']());
                    if (touchSupported) {
                        writtenShape = viewportShape();
                    }
                }

                if (touchSupported || !hasEffects) {
                    // Touch devices run no motion; the full-height
                    // geometry still follows a new viewport width or
                    // orientation.
                    if (fullHeight) {
                        pageSubscriptions.push(new Subscription('resize', $w, pageResizeHandler));
                    }
                    return;
                }

                measureHeroes(heroList);
                pageSubscriptions.push(new Subscription('scroll', $w, requestHeroFrame));
                pageSubscriptions.push(new Subscription('resize', $w, pageResizeHandler));
                // Late layout re-measures as a resize does: the body
                // changing size, and the document's load (one-shot — the
                // subscription retires with it).
                if ($d.readyState !== 'complete') {
                    pageSubscriptions.push(new Subscription('load', $w, pageResizeHandler, null, 1));
                }
                if (typeof NativeResizeObserver === 'function') {
                    try {
                        bodyObserver = new NativeResizeObserver(pageResizeHandler);
                        bodyObserver.observe(body);
                    } catch (refused) {
                        // The resize and load inputs remain.
                        bodyObserver = null;
                    }
                }
                // The motion probe runs only once markup proved the
                // feature exists; the shared utility owns the
                // MediaQueryList binding and its unobservable policy.
                motion = mediaquery['observe']('(prefers-reduced-motion: reduce)', onReducedMotionChange);
                motionOn = readMotion();
                // The first motion pass; under reduced motion — or an
                // unobservable preference — nothing is armed.
                requestHeroFrame();
            };

        // A frame is armed only when it has work: dirty geometry,
        // bounds waiting on a read phase, or motion the kept preference
        // allows. The pending mark is set before the request so the
        // frame is armed once however many events arrive before it.
        requestHeroFrame = function () {
            if (framePending || !(geometryDirty || measurePending || motionOn)) {
                return;
            }
            framePending = true;
            requestPhased(readFrame, writeFrame);
        };

        init();
        return heroscroll;
    }
);
