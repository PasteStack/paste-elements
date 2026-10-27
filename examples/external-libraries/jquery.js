/*jslint browser:true sub:true */
/*globals paste */

/**
 * App-owned wrapper. The app supplies and pins /vendor/jquery.js.
 * Only named build dependencies belong in requires declarations; the URL
 * is a runtime Paste dependency, so consumers wait until the external
 * script loads.
 * @requires paste
 * @module libs/jquery
 */
paste['define']('libs.jquery', ['/vendor/jquery.js'], function () {
    'use strict';
    return window['jQuery'];
});
