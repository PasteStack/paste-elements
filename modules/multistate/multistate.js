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

/*jslint browser:true continue:true plusplus:true sub:true unparam:true */
/*globals paste */

/**
 *
 * @compilation_level ADVANCED_OPTIMIZATIONS
 *
 * @requires paste
 * @requires paste/util
 * @requires paste/dom
 * @requires paste/event
 * @requires paste/guid
 * @module paste/ui/multistate
 *
 * Native radios select; CSS presents; this module reflects selection and history.
 * One radio per key/value; several panels may share that pair.
 * Author names and label ids; missing ones receive generated values.
 * Keys and values are URI encoded in the fragment and reflected class suffixes.
 * The public state and event payload are shared objects, as in the original; treat them
 * as read-only observations. There is no mirrored-strip or form-reset adapter.
 *
 * @example
 * http://jsfiddle.net/lauckness/f2u3r/
 *
 * <style type="text/css">
 *     [data-multistate-value] { display:none; }
 *     input[data-multistate-key]:checked ~ [data-multistate-state] { display: block; }
 * </style>
 *
 * <input id="my-id-1" type="radio" data-multistate-key="area1" value="tab1" checked="checked"/>
 * <label for="my-id-1">tab 1</label>
 * <div data-multistate-key="area1" data-multistate-value="tab1">area 1, content 1</div>
 * <input id="my-id-2" type="radio" data-multistate-key="area1" value="tab2"/>
 * <label for="my-id-2">tab 2</label>
 * <div data-multistate-key="area1" data-multistate-value="tab2">area 1, content 2</div>
 *
 * <input id="my-id-3" type="radio" data-multistate-key="area2" value="tab1"/>
 * <label for="my-id-3">tab 3</label>
 * <div data-multistate-key="area2" data-multistate-value="tab1">area 2, content 1</div>
 * <input id="my-id-4" type="radio" data-multistate-key="area2" value="tab2"/>
 * <label for="my-id-4">tab 4</label>
 * <div data-multistate-key="area2" data-multistate-value="tab2">area 2, content 2</div>
 *
 */

paste['define'](
    'paste.ui.multistate',
    [
        'paste.util',
        'paste.dom',
        'paste.event',
        'paste.guid'
    ],
    function (module, util, dom, event, guid) {
        'use strict';

        var result,

        // region Constants
            HASH_CHANGE = 'hashchange',
            POP_STATE = 'popstate',
            KEY_DATA_ATTR = 'data-multistate-key',
            VALUE_DATA_ATTR = 'data-multistate-value',
            SELECTED_CLASS_PREFIX = 'multistate-state',
            SELECTED_DATA_ATTR = 'data-' + SELECTED_CLASS_PREFIX,
            STATE_POP_EVENT_NAME = 'multistatepop',
        // endregion

        // region Locals
            objectKeysFnRef = Object['keys'],
            objectCreateFnRef = Object['create'],
            lengthProp = 'length',
            has_initialized = false,
            statePopEvent = new event['Event'](window, STATE_POP_EVENT_NAME),
            moduleGuid = guid['Guid']['create'](),

            popstateSubscription,

            stateElements,
            stateElement,
            stateElementId,
            stateElementsLength,
            stateElementKey,
            stateElementValueKey,
            stateTriggerElementsDict,
            stateContentElementsDict,
            stateValueSelectedDict,
            initialStateValueSelectedDict,
            defaultStateValueSelectedDict,
            stateElementChangeSubscriptions,

        // region Utility
            deserializeState = function deserializeState(stateString) {
                var stateParts,
                    statePartsLength,
                    stateKeyValue,
                    deserialized = objectCreateFnRef(null);

                stateString = stateString === undefined ? window['location']['hash'] : stateString;

                if (stateString && util['stringStartsWith'](stateString, '#')) {
                    stateString = stateString['slice'](1, stateString[lengthProp]);
                }

                if (stateString) {
                    stateParts = stateString['split'](',');
                }

                if (stateParts) {
                    statePartsLength = stateParts[lengthProp];
                }

                if (statePartsLength) {
                    while (statePartsLength--) {
                        stateKeyValue = stateParts[statePartsLength]['split'](':');
                        if (stateKeyValue && stateKeyValue[lengthProp] > 1) {
                            try {
                                deserialized[decodeURIComponent(stateKeyValue[0])] = decodeURIComponent(stateKeyValue[1]);
                            } catch (ignore) {
                                // Ignore an invalid URI token; the remaining dimensions still work.
                            }
                        }
                    }
                }

                return deserialized;
            },
            serializeState = function serializeState(stateValueSelectedDict) {
                var keys = objectKeysFnRef(stateValueSelectedDict),
                    keysLen = keys[lengthProp],
                    key,
                    serialized = '';

                while (keysLen--) {
                    key = keys[keysLen];
                    if (serialized[lengthProp]) {
                        serialized += ',';
                    }
                    serialized += encodeURIComponent(key) + ':' + encodeURIComponent(stateValueSelectedDict[key]);
                }

                return serialized;
            },
        // endregion

            updateMultiState = function updateMultiState(updatedStateDict, silent) {
                var keys = objectKeysFnRef(stateContentElementsDict),
                    keysLength = keys[lengthProp],
                    key,
                    value,
                    unselectedValue,
                    unselectedContentElementsDict = objectCreateFnRef(null),
                    unselectedContentElementsDictKeys,
                    unselectedContentElementsDictKeysLength,
                    selectedContentElementsDict = objectCreateFnRef(null),
                    selectedContentElementsDictKeys,
                    selectedContentElementsDictKeysLength,
                    updatedStateValueSelectedDict = objectCreateFnRef(null),
                    updatableElement,
                    updatableElementsLength,
                    className,
                    changed = false;

                // A declared key is visited once; Array.pop(key) never removed
                // a named key, and the old remaining-key loop used an exhausted index.
                while (keysLength--) {
                    key = keys[keysLength];
                    value = updatedStateDict && updatedStateDict[key];
                    if (!value || !stateContentElementsDict[key][value]) {
                        value = undefined;
                    }
                    unselectedValue = stateValueSelectedDict[key];
                    if (value !== undefined) {
                        updatedStateValueSelectedDict[key] = value;
                    }
                    if (unselectedValue !== value) {
                        changed = true;
                        if (unselectedValue !== undefined) {
                            unselectedContentElementsDict[key] = stateContentElementsDict[key][unselectedValue];
                        }
                        if (value !== undefined) {
                            selectedContentElementsDict[key] = stateContentElementsDict[key][value];
                        }
                    }
                }

                // remove attributes
                unselectedContentElementsDictKeys = objectKeysFnRef(unselectedContentElementsDict);
                unselectedContentElementsDictKeysLength = unselectedContentElementsDictKeys[lengthProp];
                while (unselectedContentElementsDictKeysLength--) {
                    key = unselectedContentElementsDictKeys[unselectedContentElementsDictKeysLength];
                    value = unselectedContentElementsDict[key];
                    updatableElement = stateTriggerElementsDict[key][stateValueSelectedDict[key]];
                    if (updatableElement && updatableElement['checked']) {
                        updatableElement['checked'] = false;
                    }
                    className = SELECTED_CLASS_PREFIX + '-' + encodeURIComponent(key) + '-' + encodeURIComponent(stateValueSelectedDict[key]);
                    updatableElementsLength = value[lengthProp];
                    while (updatableElementsLength--) {
                        updatableElement = value[updatableElementsLength];
                        updatableElement['removeAttribute'](SELECTED_DATA_ATTR);
                        dom['removeCssClass'](updatableElement, className);
                    }
                }

                // add attributes
                selectedContentElementsDictKeys = objectKeysFnRef(selectedContentElementsDict);
                selectedContentElementsDictKeysLength = selectedContentElementsDictKeys[lengthProp];
                while (selectedContentElementsDictKeysLength--) {
                    key = selectedContentElementsDictKeys[selectedContentElementsDictKeysLength];
                    value = selectedContentElementsDict[key];
                    updatableElement = stateTriggerElementsDict[key][updatedStateDict[key]];
                    if (updatableElement && !updatableElement['checked']) {
                        updatableElement['checked'] = true;
                    }
                    className = SELECTED_CLASS_PREFIX + '-' + encodeURIComponent(key) + '-' + encodeURIComponent(updatedStateDict[key]);
                    updatableElementsLength = value[lengthProp];
                    while (updatableElementsLength--) {
                        updatableElement = value[updatableElementsLength];
                        updatableElement['setAttribute'](SELECTED_DATA_ATTR, updatedStateDict[key]);
                        dom['addCssClass'](updatableElement, className);
                    }
                }

                if (changed) {
                    stateValueSelectedDict = updatedStateValueSelectedDict;
                    if (!silent) {
                        statePopEvent['fire'](stateValueSelectedDict);
                    }
                }
            },

        // region Event Handling
            stateChangeHandler = function stateChangeHandler(e) {
                var stateInputElement = event['getEventTarget'](e),
                    stateInputKey = stateInputElement['getAttribute'](KEY_DATA_ATTR),
                    currentState = deserializeState(),
                    keys = objectKeysFnRef(stateValueSelectedDict),
                    keysLength = keys[lengthProp],
                    key;

                // An empty decoded hash is still truthy. Carry the current
                // dimensions forward before changing the triggering one.
                while (keysLength--) {
                    key = keys[keysLength];
                    currentState[key] = stateValueSelectedDict[key];
                }
                currentState[stateInputKey] = stateInputElement['value'];

                try {
                    window['history']['pushState'](currentState, '', '#' + serializeState(currentState));
                } catch (ignore) {
                    // A refused history write must not strand the selected radio's panel.
                }
                updateMultiState(currentState);
            },
            genericStateChangeHandler = function genericStateChangeHandler(e) {
                var desiredStateDict = deserializeState(),
                    keys = objectKeysFnRef(desiredStateDict),
                    keysLength = keys[lengthProp],
                    declared = false;

                // The address is authoritative. Keep both native event families;
                // updateMultiState ignores their duplicate, unchanged transition.
                while (keysLength--) {
                    if (stateContentElementsDict[keys[keysLength]]) {
                        declared = true;
                    }
                }
                if (declared) {
                    updateMultiState(desiredStateDict);
                } else if (e['type'] === POP_STATE && window['location']['href'].indexOf('#') < 0) {
                    updateMultiState(defaultStateValueSelectedDict);
                }
                // An ordinary #anchor (including #) is not a selection request.
            },
        // endregion

        // region Initialization
            initialize = function initialize(force) {
                var subKeys,
                    subKeysLength,
                    subscriptionKey,
                    subscription;
                if (has_initialized && !force) {
                    return;
                }
                if (has_initialized) {
                    updateMultiState(null, true);
                    subKeys = objectKeysFnRef(stateElementChangeSubscriptions);
                    subKeysLength = subKeys[lengthProp];

                    while (subKeysLength--) {
                        subscriptionKey = subKeys[subKeysLength];
                        subscription = stateElementChangeSubscriptions[subscriptionKey];
                        subscription['dispose']();
                        delete stateElementChangeSubscriptions[subscriptionKey];
                    }

                }

                stateElements = dom['querySelectorAll']('[' + KEY_DATA_ATTR + ']');
                stateElementsLength = stateElements[lengthProp];
                stateTriggerElementsDict = objectCreateFnRef(null);
                stateContentElementsDict = objectCreateFnRef(null);
                stateValueSelectedDict = objectCreateFnRef(null);
                stateElementChangeSubscriptions = objectCreateFnRef(null);

                initialStateValueSelectedDict = deserializeState();
                defaultStateValueSelectedDict = objectCreateFnRef(null);

                while (stateElementsLength--) {
                    stateElement = stateElements[stateElementsLength];

                    stateElementKey = stateElement['getAttribute'](KEY_DATA_ATTR);
                    stateElementValueKey = stateElement['hasAttribute'](VALUE_DATA_ATTR) ?
                            stateElement['getAttribute'](VALUE_DATA_ATTR) : stateElement['value'];
                    if (!stateElementKey || !stateElementValueKey ||
                            (!stateElement['hasAttribute'](VALUE_DATA_ATTR) &&
                            (stateElement['tagName'] !== 'INPUT' || stateElement['type'] !== 'radio'))) {
                        continue;
                    }
                    if (!stateContentElementsDict[stateElementKey]) {
                        stateContentElementsDict[stateElementKey] = objectCreateFnRef(null);
                    }
                    if (!stateTriggerElementsDict[stateElementKey]) {
                        stateTriggerElementsDict[stateElementKey] = objectCreateFnRef(null);
                    }

                    if (!stateContentElementsDict[stateElementKey][stateElementValueKey]) {
                        stateContentElementsDict[stateElementKey][stateElementValueKey] = [];
                    }

                    if (stateElement['hasAttribute'](VALUE_DATA_ATTR)) {
                        stateContentElementsDict[stateElementKey][stateElementValueKey]['push'](stateElement);
                    } else if (stateElement['tagName'] === 'INPUT' && stateElement['type'] === 'radio') {
                        stateTriggerElementsDict[stateElementKey][stateElementValueKey] = stateElement;

                        stateElementId = stateElement['id'] = (
                            stateElement['id'] || guid['Guid']['create']()
                        );
                        stateElement['name'] = stateElement['name'] || stateElementKey + '$' + moduleGuid;

                        if (stateElement['defaultChecked'] && defaultStateValueSelectedDict[stateElementKey] === undefined) {
                            defaultStateValueSelectedDict[stateElementKey] = stateElement['value'];
                            if (initialStateValueSelectedDict[stateElementKey] === undefined) {
                                initialStateValueSelectedDict[stateElementKey] = stateElement['value'];
                            }
                        }

                        stateElementChangeSubscriptions[stateElementId] = event['bind'](
                            'change',
                            stateElement,
                            stateChangeHandler
                        );
                    }
                }

                subKeys = objectKeysFnRef(defaultStateValueSelectedDict);
                subKeysLength = subKeys[lengthProp];
                while (subKeysLength--) {
                    stateElementKey = subKeys[subKeysLength];
                    if (!stateContentElementsDict[stateElementKey][initialStateValueSelectedDict[stateElementKey]]) {
                        initialStateValueSelectedDict[stateElementKey] = defaultStateValueSelectedDict[stateElementKey];
                    }
                }
                updateMultiState(initialStateValueSelectedDict);
                initialStateValueSelectedDict = null;

                has_initialized = true;
                if (objectKeysFnRef(stateContentElementsDict)[lengthProp] && !popstateSubscription) {
                    popstateSubscription = event['bind'](POP_STATE, window, genericStateChangeHandler);
                    event['bind'](HASH_CHANGE, window, genericStateChangeHandler);
                }
            };
        // endregion
        // endregion

        initialize();

        result = {
            'initialize': initialize,
            'events': {},
            'getCurrentState': function () {
                return stateValueSelectedDict;
            },
            'serializeState': serializeState,
            'deserializeState': deserializeState
        };
        result['events'][statePopEvent['getEventName']()] = statePopEvent;
        return result;
    }
);
