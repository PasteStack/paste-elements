/**
 * Hero scroll parallax effect
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/throttle
 * @module paste/ui/heroscroll
 */

paste.define(
    'paste.ui.heroscroll',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.throttle'
    ],
    function (module, dom, event, throttle) {
        'use strict';
        
        var HERO_SELECTOR = '[data-paste-hero]',
            PARALLAX_ATTR = 'data-paste-parallax',
            PARALLAX_SPEED = 0.5,
            
            heroes = [],
            
            initHero = function(el) {
                var name = el.getAttribute('data-paste-hero'),
                    hasParallax = el.getAttribute(PARALLAX_ATTR) === 'true';
                
                heroes.push({
                    el: el,
                    name: name,
                    parallax: hasParallax,
                    offsetTop: el.offsetTop,
                    height: el.offsetHeight
                });
            },
            
            updateParallax = function() {
                var scrollY = window.pageYOffset || document.documentElement.scrollTop;
                
                heroes.forEach(function(hero) {
                    if (hero.parallax) {
                        var offset = (scrollY - hero.offsetTop) * PARALLAX_SPEED;
                        hero.el.style.backgroundPositionY = offset + 'px';
                    }
                });
            },
            
            onScroll = throttle(updateParallax, 16, 'heroscroll'),
            
            init = function() {
                var heroElements = dom.get(HERO_SELECTOR, true);
                
                if (heroElements && heroElements.length) {
                    heroElements.forEach(initHero);
                    event['bind']('scroll', window, onScroll);
                    updateParallax();
                }
            };
        
        // Initialize on DOM ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
        
        module.init = init;
        module.updateParallax = updateParallax;
    }
);
