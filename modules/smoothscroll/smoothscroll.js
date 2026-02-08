/**
 * Smooth scroll for anchor links
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/smoothscroll
 */

paste.define(
    'paste.ui.smoothscroll',
    [
        'paste.dom',
        'paste.event'
    ],
    function (module, dom, event) {
        'use strict';
        
        var SMOOTH_SELECTOR = 'a[href^="#"]',
            DURATION = 500,
            EASING = function(t) {
                // easeInOutCubic
                return t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1;
            },
            
            scrollTo = function(target, duration) {
                var startPosition = window.pageYOffset,
                    targetPosition = target.getBoundingClientRect().top + startPosition,
                    distance = targetPosition - startPosition,
                    startTime = null;
                
                function animation(currentTime) {
                    if (startTime === null) startTime = currentTime;
                    var timeElapsed = currentTime - startTime,
                        progress = Math.min(timeElapsed / duration, 1),
                        ease = EASING(progress);
                    
                    window.scrollTo(0, startPosition + distance * ease);
                    
                    if (timeElapsed < duration) {
                        requestAnimationFrame(animation);
                    }
                }
                
                requestAnimationFrame(animation);
            },
            
            handleClick = function(e) {
                var href = this.getAttribute('href'),
                    target;
                
                if (href && href.length > 1) {
                    target = dom.get(href);
                    
                    if (target) {
                        e.preventDefault();
                        scrollTo(target, DURATION);
                        
                        // Update URL hash without jumping
                        if (history.pushState) {
                            history.pushState(null, null, href);
                        }
                    }
                }
            },
            
            init = function() {
                var links = dom.get(SMOOTH_SELECTOR, true);
                
                if (links && links.length) {
                    links.forEach(function(link) {
                        event['bind']('click', link, handleClick);
                    });
                }
            };
        
        // Initialize on DOM ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
        
        module.init = init;
        module.scrollTo = scrollTo;
    }
);
