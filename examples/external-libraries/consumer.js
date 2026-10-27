/*jslint browser:true sub:true */
/*globals paste */

/**
 * @requires libs/jquery
 * @module example/jquery-consumer
 */
paste['define']('example.jquery-consumer', ['libs.jquery'], function (module, jquery) {
    'use strict';
    // Use the dependency argument: this factory runs after jQuery has loaded.
    module['jquery'] = jquery;
});
