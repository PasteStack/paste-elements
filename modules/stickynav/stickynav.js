/**
 * Sticky navigation
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/ui/throttle
 * @module paste/ui/stickynav
 */

paste.define(
    'paste.ui.stickynav',
    [
        'paste.dom',
        'paste.event',
        'paste.ui.throttle'
    ],
    function (module, dom, event, throttle) {
        'use strict';
        
        var STICKY_SELECTOR = '[data-paste-sticky-nav]',
            STICKY_TARGET_SELECTOR = '[data-paste-sticky-target]',
            STICKY_CLASS = 'paste-ui-sticky',
            STICKY_ACTIVE_CLASS = 'paste-ui-sticky-active',
            
            navs = [],
            
            initNav = function(el) {
                var targetSelector = el.getAttribute('data-paste-sticky-nav'),
                    target = targetSelector ? dom.get(targetSelector) : dom.get(STICKY_TARGET_SELECTOR),
                    offsetTop = el.offsetTop;
                
                navs.push({
                    el: el,
                    target: target,
                    offsetTop: offsetTop,
                    height: el.offsetHeight,
                    isSticky: false
                });
                
                el.classList.add(STICKY_CLASS);
            },
            
            updateSticky = function() {
                var scrollY = window.pageYOffset || document.documentElement.scrollTop;
                
                navs.forEach(function(nav) {
                    var triggerPoint = nav.target ? 
                        nav.target.offsetTop + nav.target.offsetHeight : 
                        nav.offsetTop;
                    
                    if (scrollY >= triggerPoint && !nav.isSticky) {
                        nav.el.classList.add(STICKY_ACTIVE_CLASS);
                        nav.isSticky = true;
                    } else if (scrollY < triggerPoint && nav.isSticky) {
                        nav.el.classList.remove(STICKY_ACTIVE_CLASS);
                        nav.isSticky = false;
                    }
                });
            },
            
            onScroll = throttle(updateSticky, 16, 'stickynav'),
            
            init = function() {
                var navElements = dom.get(STICKY_SELECTOR, true);
                
                if (navElements && navElements.length) {
                    navElements.forEach(initNav);
                    event['bind']('scroll', window, onScroll);
                    updateSticky();
                }
            };
        
        // Initialize on DOM ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
        
        module.init = init;
        module.updateSticky = updateSticky;
    }
);
