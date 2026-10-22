/*jslint browser:true continue:true plusplus:true sub:true */
/*globals paste */

/**
 * Multi-dimension hash-based state manager using #key:value,key:value format.
 * Manages UI state (tabs, radio inputs) via hash with popstate/hashchange support.
 * Designed for SPA-style interfaces where form elements drive state transitions.
 *
 * Triggers are form inputs carrying a value (radios); anchors are not
 * triggers.
 *
 * Every trigger counts: several radios may declare the same key and
 * value (a mirrored tab strip), and each of them is named, checked and
 * unchecked with the selection.
 *
 * Radio naming (inherited from the original multistate): a key whose
 * radio triggers carry no authored name gets one generated name per
 * strip, so each strip unchecks natively and moves with the arrow keys
 * as one group. Strips follow the markup: a radio's strip reaches up to
 * its highest ancestor that holds no two of the key's radios with one
 * value, and never past a fieldset, [role=radiogroup] or [role=tablist];
 * such an ancestor holding several radios is one strip. Radios that are
 * each alone in theirs, side by side — under one parent, or under
 * sibling parents such as the cells of a table's rows or the items of a
 * list, never across a declared group — are read in order and split
 * where a value repeats, so flat strips written one after another stay
 * whole. When that split would need more strips than the most repeated
 * value has radios, the strips are interleaved (a grid filled row by
 * row, a table with a strip per column) and the nth radio of each value
 * joins the nth strip instead; a value only a later interleaved strip
 * offers joins the first, so interleaved strips that differ in values
 * need authored names. Flat markup cannot say where a strip ends before
 * a value repeats: in x y z x y, z stays with the first strip; a
 * wrapper element or a declared group places it. Strips may
 * differ in their values: a value only one strip offers never borrows
 * another strip's group. The first strip in document order is named
 * 'paste-ui-multistate:' plus the key, the next the same plus ':1',
 * then ':2', and so on. A key holding ':' or '%' is written encoded
 * with encodeURIComponent instead; an encoded key always holds '%' and
 * never ':', so a strip's name never equals another key's (key 'a',
 * strip 1 and key 'a:1', named 'paste-ui-multistate:a%3A1', stay
 * apart). Every strip shows the selection. A key where any radio
 * carries an authored name is left exactly as authored.
 *
 * Authored defaults: the trigger authored checked — its checked
 * attribute (defaultChecked), never the live checked state, so a re-scan
 * by initialize(true) keeps the markup's defaults rather than adopting
 * the current selection. When several triggers of one key are authored
 * checked, the last in document order is the default — the one a
 * browser keeps checked in a named group.
 *
 * Hash resolution: a fragment that names at least one declared key in a
 * key:value token applies its declared pairs; every declared key the
 * fragment does not name, or names with an undeclared value, falls back
 * to its authored default, and a key with no authored default is left
 * unselected. A fragment with no declared key:value token — a plain
 * anchor such as '#top', an empty one such as the '#' of
 * <a href="#">, or another script's tokens only — is not this module's
 * state: a hashchange or popstate to it keeps the current selection, so
 * an in-page link never resets a tab. Only a popstate to an entry whose
 * address carries no '#' at all (Back to the page's first entry)
 * restores the authored defaults.
 *
 * Encoding: keys and values
 * are written to the fragment with encodeURIComponent and decoded on
 * read; a token that does not decode is ignored. The reflected class is
 * multistate-state-{key}-{value} with each part encodeURIComponent'd, so
 * whitespace and other characters a class token cannot hold arrive
 * escaped ('north america' becomes north%20america); the data attribute
 * and the reported state keep the original text. Letters, digits and
 * -_.!~*'() read and reflect unchanged; everything else is escaped.
 * Text holding a lone surrogate, which encodeURIComponent refuses, is
 * escaped a code unit at a time with each surrogate written %uXXXX: its
 * class and generated name stay distinct from every other key's, and
 * its fragment token never decodes, so such a selection works on the
 * page but is not restored from the address.
 *
 * History writes: an input change applies the new selection first, then
 * pushes a fragment serialized from the selection as applied, carrying
 * every declared key's current selection,
 * keeping every key:value token in the current fragment whose key the
 * page does not declare — another enhancement's state rides along
 * untouched, ahead of this module's tokens and in its original order.
 * The pushed entry's state object is null: the fragment is the module's
 * whole record, and another script's history.state is never copied into
 * entries it did not create. A refused pushState (a SecurityError or a
 * rate limit) leaves the selection applied and the address unchanged; it
 * never escapes the change handler.
 *
 * The multistatepop announcement carries a snapshot of the selection. A
 * listener that changes the selection while it is being announced gets
 * its own announcement after the current one finishes, in order. Such a
 * nested change pushes no entry of its own: the change that started the
 * announcement pushes one entry once every nested change has applied,
 * so the top history entry always describes the final selection.
 *
 * Public surface, inherited from the original multistate and kept as documented
 * exceptions to the declarative-only rule for Elements — new modules do
 * not add such members:
 * - initialize(force): the module binds itself when defined; a call
 *   without force does nothing, and initialize(true) re-scans the
 *   document — change listeners on the previous triggers are disposed,
 *   the previous selection's reflection is cleared, and the selection is
 *   resolved again from the fragment and the triggers checked now.
 * - events.multistatepop: the paste.event Event announced on each change.
 * - getCurrentState(): a snapshot of the selection.
 * - serializeState(dict) / deserializeState(string): the fragment codec.
 *   deserializeState() with no argument reads the current location.hash;
 *   an empty string is an empty state.
 * Every object these members hand out (the snapshot, the decoded state,
 * the multistatepop payload) is a plain object: hasOwnProperty and
 * string coercion work as usual, and a key named like an Object.prototype
 * member ('__proto__', 'constructor') is an ordinary own property.
 *
 * @requires paste/util
 * @requires paste/dom
 * @requires paste/event
 * @module paste/ui/multistate
 *
 * @example
 *
 * Without JavaScript the authored radios must already drive the page:
 * each radio group shares an authored name so checking one unchecks
 * its siblings, and sibling selectors reveal the checked panel. The
 * module's state attribute is an enhancement — nothing in the
 * baseline may depend on it.
 *
 * <style type="text/css">
 *     [data-multistate-value] { display: none; }
 *     #my-id-1:checked ~ [data-multistate-key="area1"][data-multistate-value="tab1"],
 *     #my-id-2:checked ~ [data-multistate-key="area1"][data-multistate-value="tab2"],
 *     #my-id-3:checked ~ [data-multistate-key="area2"][data-multistate-value="tab1"],
 *     #my-id-4:checked ~ [data-multistate-key="area2"][data-multistate-value="tab2"] { display: block; }
 * </style>
 *
 * <input id="my-id-1" name="area1" type="radio" data-multistate-key="area1" value="tab1" checked="checked"/>
 * <label for="my-id-1">tab 1</label>
 * <input id="my-id-2" name="area1" type="radio" data-multistate-key="area1" value="tab2"/>
 * <label for="my-id-2">tab 2</label>
 * <div data-multistate-key="area1" data-multistate-value="tab1">area 1, content 1</div>
 * <div data-multistate-key="area1" data-multistate-value="tab2">area 1, content 2</div>
 *
 * <input id="my-id-3" name="area2" type="radio" data-multistate-key="area2" value="tab1"/>
 * <label for="my-id-3">tab 3</label>
 * <input id="my-id-4" name="area2" type="radio" data-multistate-key="area2" value="tab2"/>
 * <label for="my-id-4">tab 4</label>
 * <div data-multistate-key="area2" data-multistate-value="tab1">area 2, content 1</div>
 * <div data-multistate-key="area2" data-multistate-value="tab2">area 2, content 2</div>
 *
 * Enhanced: the module reflects the resolved selection onto the
 * content's data-multistate-state attribute and a
 * multistate-state-{key}-{value} class, so stylesheet rules like
 * [data-multistate-state] { display: block; } can style the enhanced
 * state independently of the authored radio reveal.
 *
 */

paste['define'](
    'paste.ui.multistate',
    [
        'paste.util',
        'paste.dom',
        'paste.event'
    ],
    function (module, util, dom, event) {
        'use strict';

        var $w = window,
            $history = $w['history'],
            $keys = Object['keys'],
            $create = Object['create'],
            $defineProperty = Object['defineProperty'],
            $encode = encodeURIComponent,
            $decode = decodeURIComponent,
            Subscription = event['Event']['Subscription'],
            HASH_CHANGE = 'hashchange',
            POP_STATE = 'popstate',
            KEY_DATA_ATTR = 'data-multistate-key',
            VALUE_DATA_ATTR = 'data-multistate-value',
            SELECTED_CLASS_PREFIX = 'multistate-state',
            SELECTED_DATA_ATTR = 'data-' + SELECTED_CLASS_PREFIX,
            STATE_POP_EVENT_NAME = 'multistatepop',
            GENERATED_NAME_PREFIX = 'paste-ui-multistate:',
            // What a mirrored strip's generated name adds to the key's.
            STRIP_NAME_SUFFIX = /^:[1-9][0-9]*$/,
            FIELDSET = 'fieldset',
            statePopEvent = new event['Event']($w, STATE_POP_EVENT_NAME),

            stateTriggerElementsDict,
            stateContentElementsDict,
            stateValueSelectedDict,
            // The authored checked trigger per key — what a
            // fragment that does not name the key falls back to.
            authoredDefaultsDict,
            usableDeclarations = 0,
            initialized = false,
            // The page-lifetime history subscriptions, once bound.
            historySubscriptions = null,
            // Change subscriptions on the current triggers, disposed by a
            // re-scan.
            changeSubscriptions = [],
            // Announcements waiting for the one in flight to finish.
            announcements = [],
            announcing = false,
            // Input changes being applied; only the outermost pushes.
            changeDepth = 0,

            // URL text must never reach prototype keys: every dictionary
            // the hash feeds is prototype-free, so '__proto__' and friends
            // stay ordinary undeclared keys that the declared-dimension
            // filter drops.
            emptyDict = function () {
                return $create(null);
            },
            copyDict = function (source) {
                var copy = emptyDict(),
                    keys = $keys(source),
                    keysLength = keys.length,
                    key;
                while (keysLength--) {
                    key = keys[keysLength];
                    copy[key] = source[key];
                }
                return copy;
            },
            // What the public members hand out: an ordinary object whose
            // own data properties hold every key, '__proto__' included.
            plainCopy = function (source) {
                var copy = {},
                    keys = $keys(source),
                    keysLength = keys.length,
                    key;
                while (keysLength--) {
                    key = keys[keysLength];
                    $defineProperty(copy, key, {
                        value: source[key],
                        writable: true,
                        enumerable: true,
                        configurable: true
                    });
                }
                return copy;
            },
            decodeToken = function (token) {
                try {
                    return $decode(token);
                } catch (malformed) {
                    return null;
                }
            },
            // encodeURIComponent, which refuses text holding a lone
            // surrogate (an attribute can carry one). Such text is
            // written a code unit at a time instead, each surrogate as
            // %u and four hex digits: a form encodeURIComponent never
            // writes, so it meets no other text's encoding, and one that
            // never decodes, so the address cannot select it.
            encodeText = function (text) {
                var remaining,
                    index = 0,
                    unit,
                    escaped = '';
                try {
                    return $encode(text);
                } catch (malformed) {
                    remaining = text.length;
                }
                while (remaining--) {
                    unit = text.charCodeAt(index);
                    escaped += unit >= 0xD800 && unit <= 0xDFFF ? '%u' + unit.toString(16).toUpperCase() :
                            $encode(text.charAt(index));
                    index += 1;
                }
                return escaped;
            },
            // Generated class suffixes are whitespace-free tokens while
            // keys and values are free text — encode only for the class
            // name; data attributes and state keep the original text.
            classFor = function (key, value) {
                return SELECTED_CLASS_PREFIX + '-' + encodeText(key) + '-' + encodeText(value);
            },
            currentFragment = function () {
                var hash = $w['location']['hash'] || '';
                return util['stringStartsWith'](hash, '#') ? hash.slice(1) : hash;
            },
            deserializeState = function (stateString) {
                var stateParts,
                    statePartsLength,
                    stateKeyValue,
                    deserialized = emptyDict(),
                    key;

                if (stateString === undefined || stateString === null) {
                    stateString = $w['location']['hash'];
                }
                if (stateString && util['stringStartsWith'](stateString, '#')) {
                    stateString = stateString.slice(1);
                }
                if (!stateString) {
                    return deserialized;
                }
                stateParts = stateString.split(',');
                statePartsLength = stateParts.length;
                while (statePartsLength--) {
                    stateKeyValue = stateParts[statePartsLength].split(':');
                    key = stateKeyValue.length > 1 ? decodeToken(stateKeyValue[0]) : null;
                    if (key !== null) {
                        deserialized[key] = decodeToken(stateKeyValue[1]);
                    }
                }
                return deserialized;
            },
            serializeState = function (stateDict) {
                var keys = $keys(stateDict),
                    keysLen = keys.length,
                    key,
                    serialized = '';

                while (keysLen--) {
                    key = keys[keysLen];
                    if (serialized.length) {
                        serialized += ',';
                    }
                    serialized += encodeText(key) + ':' + encodeText(stateDict[key]);
                }
                return serialized;
            },
            // A key the page declares, through a trigger or content.
            declaredKey = function (key) {
                return !!(stateTriggerElementsDict[key] || stateContentElementsDict[key]);
            },
            // Walks the fragment's key:value tokens forward. keepForeign
            // true: returns the tokens whose keys this page does not
            // declare — another enhancement's state, kept verbatim and in
            // order. keepForeign false: returns '' as soon as one token
            // names a declared key, null when none does. Tokens without a
            // key:value shape (a plain anchor) are never state.
            scanTokens = function (fragment, keepForeign) {
                var parts,
                    partsLength,
                    partIndex = 0,
                    part,
                    separator,
                    key,
                    kept = '';
                if (!fragment) {
                    return keepForeign ? kept : null;
                }
                parts = fragment.split(',');
                partsLength = parts.length;
                while (partsLength--) {
                    part = parts[partIndex];
                    partIndex += 1;
                    separator = part.indexOf(':');
                    if (separator > 0) {
                        key = decodeToken(part.slice(0, separator));
                        if (key !== null) {
                            if (declaredKey(key)) {
                                if (!keepForeign) {
                                    return kept;
                                }
                            } else if (keepForeign) {
                                kept += (kept.length ? ',' : '') + part;
                            }
                        }
                    }
                }
                return keepForeign ? kept : null;
            },
            statesEqual = function (a, b) {
                var aKeys = $keys(a),
                    aKeysLength = aKeys.length,
                    key;

                if (aKeysLength !== $keys(b).length) {
                    return false;
                }
                while (aKeysLength--) {
                    key = aKeys[aKeysLength];
                    if (a[key] !== b[key]) {
                        return false;
                    }
                }
                return true;
            },
            selectable = function (key, value) {
                return !!(value && stateContentElementsDict[key] && stateContentElementsDict[key][value]);
            },
            // A fragment's selection for every declared key: the
            // fragment's own declared value where it names one, the
            // authored default otherwise.
            withAuthoredDefaults = function (desired) {
                var keys = $keys(authoredDefaultsDict),
                    keysLength = keys.length,
                    key;
                while (keysLength--) {
                    key = keys[keysLength];
                    if (!selectable(key, desired[key])) {
                        desired[key] = authoredDefaultsDict[key];
                    }
                }
                return desired;
            },

            // One announcement at a time: dispatching the event object
            // already in flight throws, so a change made by a listener
            // waits until the current dispatch returns.
            announce = function (snapshot) {
                announcements.push(snapshot);
                if (announcing) {
                    return;
                }
                announcing = true;
                try {
                    while (announcements.length) {
                        statePopEvent['fire'](announcements.shift());
                    }
                } finally {
                    announcing = false;
                }
            },

            // Every trigger of the key follows the selection: those
            // declaring the value are checked, every other is unchecked
            // (unnamed radios never uncheck one another). A missing value
            // unchecks them all.
            checkTriggers = function (key, value) {
                var triggers = stateTriggerElementsDict[key],
                    values = triggers ? $keys(triggers) : [],
                    valuesLength = values.length,
                    elements,
                    elementsLength,
                    checked;
                while (valuesLength--) {
                    elements = triggers[values[valuesLength]];
                    checked = values[valuesLength] === value;
                    elementsLength = elements.length;
                    while (elementsLength--) {
                        elements[elementsLength]['checked'] = checked;
                    }
                }
            },

            // Removes the reflection of one key's selected value.
            unreflect = function (key, value) {
                var elements = stateContentElementsDict[key] && stateContentElementsDict[key][value],
                    elementsLength = elements ? elements.length : 0,
                    element;
                while (elementsLength--) {
                    element = elements[elementsLength];
                    element['removeAttribute'](SELECTED_DATA_ATTR);
                    dom['removeCssClass'](element, classFor(key, value));
                }
            },

            updateMultiState = function (updatedStateDict) {
                var availableKeys = $keys(stateContentElementsDict),
                    availableKeysLength = availableKeys.length,
                    keys = updatedStateDict ? $keys(updatedStateDict) : [],
                    keysLength = keys.length,
                    key,
                    value,
                    unselectedValue,
                    unselectedKeysDict = emptyDict(),
                    unselectedKeys,
                    unselectedKeysLength,
                    selectedContentElementsDict = emptyDict(),
                    selectedKeys,
                    selectedKeysLength,
                    updatedStateValueSelectedDict = emptyDict(),
                    updatedKeysDict = emptyDict(),
                    updatableElements,
                    updatableElement,
                    updatableElementsLength;

                // The update is authoritative: each named key replaces
                // its previous selection; a key absent from the update
                // loses whatever selection it had. Callers decide what
                // the update names — navigation fills authored defaults
                // first.
                while (keysLength--) {
                    key = keys[keysLength];
                    value = updatedStateDict[key];
                    if (selectable(key, value)) {
                        updatedKeysDict[key] = true;
                        unselectedValue = stateValueSelectedDict[key];
                        if (unselectedValue && unselectedValue !== value) {
                            unselectedKeysDict[key] = true;
                        }
                        selectedContentElementsDict[key] = stateContentElementsDict[key][value];
                        updatedStateValueSelectedDict[key] = value;
                    }
                }

                while (availableKeysLength--) {
                    key = availableKeys[availableKeysLength];
                    if (updatedKeysDict[key]) {
                        continue;
                    }
                    unselectedValue = stateValueSelectedDict[key];
                    if (unselectedValue && stateContentElementsDict[key][unselectedValue]) {
                        unselectedKeysDict[key] = true;
                    }
                }

                // A paired popstate + hashchange delivering the same
                // navigation — or any update that lands on the state
                // already applied — is one transition: no DOM writes and
                // no duplicate published event.
                if (statesEqual(stateValueSelectedDict, updatedStateValueSelectedDict)) {
                    return;
                }

                unselectedKeys = $keys(unselectedKeysDict);
                unselectedKeysLength = unselectedKeys.length;
                while (unselectedKeysLength--) {
                    key = unselectedKeys[unselectedKeysLength];
                    // the previously checked triggers for this key leave
                    // with its content; a newly selected value checks its
                    // own below
                    if (!updatedKeysDict[key]) {
                        checkTriggers(key, null);
                    }
                    unreflect(key, stateValueSelectedDict[key]);
                }

                selectedKeys = $keys(selectedContentElementsDict);
                selectedKeysLength = selectedKeys.length;
                while (selectedKeysLength--) {
                    key = selectedKeys[selectedKeysLength];
                    value = updatedStateValueSelectedDict[key];
                    checkTriggers(key, value);
                    updatableElements = selectedContentElementsDict[key];
                    updatableElementsLength = updatableElements.length;
                    while (updatableElementsLength--) {
                        updatableElement = updatableElements[updatableElementsLength];
                        updatableElement['setAttribute'](SELECTED_DATA_ATTR, value);
                        dom['addCssClass'](updatableElement, classFor(key, value));
                    }
                }

                stateValueSelectedDict = updatedStateValueSelectedDict;
                // The published payload is a snapshot: a listener
                // mutating it must not edit the module's working
                // dictionary.
                announce(plainCopy(stateValueSelectedDict));
            },

            stateChangeHandler = function (e) {
                var stateInputElement = event['getEventTarget'](e),
                    currentState = copyDict(stateValueSelectedDict),
                    // Read before anything is written: the fragment the
                    // user is leaving.
                    foreign = scanTokens(currentFragment(), true),
                    serialized;

                // The next state is built from the module's own
                // selection, not re-parsed hash text — one input change
                // carries the other dimensions.
                currentState[stateInputElement['getAttribute'](KEY_DATA_ATTR)] = stateInputElement['value'];

                // Applied first: a refused history write must never leave
                // the checked radio and the shown panel apart. A change a
                // multistatepop listener makes meanwhile lands inside this
                // call and pushes nothing itself.
                changeDepth += 1;
                try {
                    updateMultiState(currentState);
                } finally {
                    changeDepth -= 1;
                }
                if (changeDepth) {
                    return;
                }

                // Serialized from what was applied, nested changes
                // included, so the entry matches the final selection.
                serialized = serializeState(stateValueSelectedDict);

                // The fragment is shared: tokens for keys this page does
                // not declare belong to someone else and ride along. The
                // entry's state object is null — the fragment is this
                // module's whole record.
                try {
                    $history['pushState'](
                        null,
                        '',
                        '#' + foreign + (foreign.length && serialized.length ? ',' : '') + serialized
                    );
                } catch (refused) {
                    return;
                }
            },
            // Both history families stay bound for the module's
            // lifetime: browsers emit popstate, hashchange, or both for
            // one transition. The state-equality guard in
            // updateMultiState collapses a paired delivery into a single
            // observable change. The fragment is the authoritative
            // record: event.state may be a foreign script's history data.
            // An empty fragment ('page#', from <a href="#">) reads as ''
            // just like no fragment at all; only the address tells them
            // apart, and only the address without '#' is the bare entry.
            genericStateChangeHandler = function (e) {
                var fragment = currentFragment(),
                    href;
                if (scanTokens(fragment, false) !== null) {
                    updateMultiState(withAuthoredDefaults(deserializeState('#' + fragment)));
                } else if (!fragment && e && e['type'] === POP_STATE) {
                    href = $w['location']['href'];
                    if (!href || href.indexOf('#') < 0) {
                        updateMultiState(withAuthoredDefaults(emptyDict()));
                    }
                }
            },

            // A declared radio group: a strip never reaches past one.
            groupBoundary = function (node) {
                var role;
                if (node['nodeType'] !== 1) {
                    return false;
                }
                if (node['localName'] === FIELDSET) {
                    return true;
                }
                role = node['getAttribute']('role');
                return role === 'radiogroup' || role === 'tablist';
            },
            // Whether two strip roots holding one radio each stand side
            // by side, given the records of their parents: one parent,
            // or sibling parents that declare no group (the cells of a
            // table's rows, the items of a list).
            sideBySide = function (a, b) {
                if (!a || !b) {
                    return a === b;
                }
                return a['node'] === b['node'] || (!a['boundary'] && !b['boundary'] &&
                        !!a['parent'] && !!b['parent'] && a['parent']['node'] === b['parent']['node']);
            },
            // Numbers a run of side-by-side radios from base on and
            // returns how many strips it used. Read in order, the run
            // splits where a value repeats, so strips written one after
            // another stay whole. No split can use fewer strips than the
            // most repeated value has radios; when this one uses more,
            // the strips are interleaved (a grid filled row by row, a
            // table with a strip per column), and the nth radio of each
            // value joins the nth strip instead.
            numberRun = function (radios, run, numbers, base) {
                var remaining = run.length,
                    index = 0,
                    seen = emptyDict(),
                    counts = emptyDict(),
                    segment = 0,
                    most = 0,
                    value,
                    count;
                while (remaining--) {
                    value = radios[run[index]]['value'];
                    if (seen[value]) {
                        segment += 1;
                        seen = emptyDict();
                    }
                    seen[value] = true;
                    count = (counts[value] || 0) + 1;
                    counts[value] = count;
                    if (count > most) {
                        most = count;
                    }
                    numbers[run[index]] = base + segment;
                    index += 1;
                }
                if (segment < most) {
                    return segment + 1;
                }
                counts = emptyDict();
                remaining = run.length;
                index = 0;
                while (remaining--) {
                    value = radios[run[index]]['value'];
                    count = counts[value] || 0;
                    counts[value] = count + 1;
                    numbers[run[index]] = base + count;
                    index += 1;
                }
                return most;
            },
            // Each radio's strip number, for a key's radios in document
            // order. A radio's strip root is its highest ancestor (or
            // itself) that holds no two of the key's radios with one
            // value; the climb stops at a declared group. A root holding
            // several radios, or declaring a group, is one strip. Roots
            // holding one radio each form runs while they stand side by
            // side, and numberRun splits each run into strips. The walk
            // keeps one record per element above the radio being read —
            // how many of the key's radios it holds and whether a value
            // repeats among them — so a key costs its radios times their
            // depth.
            stripNumbers = function (radios) {
                var count = radios.length,
                    numbers = [],
                    leaves = [],
                    open = [],
                    chain = [],
                    run = [],
                    remaining = count,
                    index = 0,
                    strip = 0,
                    previous = null,
                    radio,
                    value,
                    node,
                    chainLength,
                    shared,
                    matched,
                    rest,
                    record,
                    parent;
                while (remaining--) {
                    radio = radios[index];
                    value = radio['value'];
                    chain.length = 0;
                    chain.push(radio);
                    node = radio['parentNode'];
                    while (node && node['nodeType'] === 1) {
                        chain.push(node);
                        node = node['parentNode'];
                    }
                    chainLength = chain.length;
                    // In document order, the previous radio's records
                    // stay open as far as the two share ancestors; the
                    // rest are complete.
                    shared = chainLength < open.length ? chainLength : open.length;
                    matched = 0;
                    while (shared-- && open[matched]['node'] === chain[chainLength - 1 - matched]) {
                        matched += 1;
                    }
                    open.length = matched;
                    rest = chainLength - matched;
                    while (rest--) {
                        open.push({
                            node: chain[rest],
                            parent: open.length ? open[open.length - 1] : null,
                            boundary: groupBoundary(chain[rest]),
                            values: emptyDict(),
                            radios: 0,
                            repeats: false,
                            strip: -1
                        });
                    }
                    rest = open.length;
                    while (rest--) {
                        record = open[rest];
                        record['radios'] += 1;
                        if (record['values'][value]) {
                            record['repeats'] = true;
                        }
                        record['values'][value] = true;
                    }
                    leaves.push(open[open.length - 1]);
                    index += 1;
                }
                chain.length = 0;
                open.length = 0;
                remaining = count;
                index = 0;
                while (remaining--) {
                    record = leaves[index];
                    parent = record['parent'];
                    while (parent && !record['boundary'] && !parent['repeats']) {
                        record = parent;
                        parent = record['parent'];
                    }
                    if (record['radios'] > 1 || record['boundary']) {
                        if (run.length) {
                            strip += numberRun(radios, run, numbers, strip);
                            run.length = 0;
                        }
                        if (record['strip'] < 0) {
                            record['strip'] = strip;
                            strip += 1;
                        }
                        numbers[index] = record['strip'];
                    } else {
                        if (run.length && !sideBySide(previous, parent)) {
                            strip += numberRun(radios, run, numbers, strip);
                            run.length = 0;
                        }
                        run.push(index);
                        previous = parent;
                    }
                    index += 1;
                }
                if (run.length) {
                    numberRun(radios, run, numbers, strip);
                }
                return numbers;
            },
            // The generated name's key part: the key itself, unless it
            // holds ':' (which would read as a strip number) or '%'
            // (which could spell another key's encoding); those keys are
            // encoded, and an encoded key always holds '%' and never ':'.
            nameKey = function (key) {
                return key.indexOf(':') < 0 && key.indexOf('%') < 0 ? key : encodeText(key);
            },

            // The original automatic radio naming: a key whose radios carry
            // no authored name gets generated names so each strip behaves
            // as one group — one shared name would merge mirrored strips
            // into one native group, leaving only one of them showing the
            // selection, and pairing radios by their count per value
            // would cross strips that differ in values. A name this
            // module generated earlier is not authored. triggersByKey
            // holds each key's triggers last-first.
            nameRadioGroups = function (triggersByKey) {
                var keys = $keys(triggersByKey),
                    keysLength = keys.length,
                    key,
                    generated,
                    triggers,
                    triggersLength,
                    trigger,
                    radios,
                    numbers,
                    name,
                    authored;
                while (keysLength--) {
                    key = keys[keysLength];
                    generated = GENERATED_NAME_PREFIX + nameKey(key);
                    triggers = triggersByKey[key];
                    triggersLength = triggers.length;
                    authored = false;
                    radios = [];
                    // Read backwards, the last-first list is in document
                    // order.
                    while (triggersLength--) {
                        trigger = triggers[triggersLength];
                        name = trigger['name'];
                        if (name && name !== generated && !(name.indexOf(generated) === 0 &&
                                STRIP_NAME_SUFFIX.test(name.slice(generated.length)))) {
                            authored = true;
                        }
                        if (trigger['type'] === 'radio') {
                            radios.push(trigger);
                        }
                    }
                    if (authored) {
                        continue;
                    }
                    numbers = stripNumbers(radios);
                    triggersLength = radios.length;
                    while (triggersLength--) {
                        radios[triggersLength]['name'] = numbers[triggersLength] ?
                                generated + ':' + numbers[triggersLength] : generated;
                    }
                }
            },

            // Clears what a previous scan wrote and disposes its change
            // subscriptions; the next scan starts from the markup.
            release = function () {
                var keys = $keys(stateValueSelectedDict),
                    keysLength = keys.length,
                    key,
                    remaining = changeSubscriptions.length;
                while (keysLength--) {
                    key = keys[keysLength];
                    unreflect(key, stateValueSelectedDict[key]);
                }
                while (remaining--) {
                    changeSubscriptions[remaining]['dispose']();
                }
                changeSubscriptions.length = 0;
            },

            bind = function () {
                var stateElements = dom['querySelectorAll']('[' + KEY_DATA_ATTR + ']'),
                    stateElementsLength = stateElements.length,
                    stateElement,
                    stateElementKey,
                    stateElementValueKey,
                    triggersByKey = emptyDict(),
                    initialState,
                    initialTriggerKeys,
                    initialTriggerKeysLength,
                    initialTriggerKey;

                stateTriggerElementsDict = emptyDict();
                stateContentElementsDict = emptyDict();
                stateValueSelectedDict = emptyDict();
                authoredDefaultsDict = emptyDict();
                usableDeclarations = 0;

                // Walked from the end of the document: the first checked
                // trigger seen per key is the last one in document order.
                while (stateElementsLength--) {
                    stateElement = stateElements[stateElementsLength];
                    stateElementKey = stateElement['getAttribute'](KEY_DATA_ATTR);

                    // A declaration is classified before it can mutate
                    // anything: content when it carries the value
                    // attribute, a trigger when it carries a value
                    // property, malformed otherwise. Malformed stays
                    // inert and never disables a valid sibling.
                    if (stateElement['hasAttribute'](VALUE_DATA_ATTR)) {
                        stateElementValueKey = stateElement['getAttribute'](VALUE_DATA_ATTR);
                        if (!stateElementKey || !stateElementValueKey) {
                            continue;
                        }
                        if (!stateContentElementsDict[stateElementKey]) {
                            stateContentElementsDict[stateElementKey] = emptyDict();
                        }
                        if (!stateContentElementsDict[stateElementKey][stateElementValueKey]) {
                            stateContentElementsDict[stateElementKey][stateElementValueKey] = [];
                        }
                        stateContentElementsDict[stateElementKey][stateElementValueKey].push(stateElement);
                        usableDeclarations += 1;
                    } else if (stateElement['value']) {
                        if (!stateElementKey) {
                            continue;
                        }
                        stateElementValueKey = stateElement['value'];
                        if (!stateTriggerElementsDict[stateElementKey]) {
                            stateTriggerElementsDict[stateElementKey] = emptyDict();
                        }
                        if (!stateTriggerElementsDict[stateElementKey][stateElementValueKey]) {
                            stateTriggerElementsDict[stateElementKey][stateElementValueKey] = [];
                        }
                        stateTriggerElementsDict[stateElementKey][stateElementValueKey].push(stateElement);
                        if (!triggersByKey[stateElementKey]) {
                            triggersByKey[stateElementKey] = [];
                        }
                        triggersByKey[stateElementKey].push(stateElement);
                        usableDeclarations += 1;

                        // Every key's authored default is captured, not
                        // just the first dimension's — from the markup's
                        // checked attribute, which no selection rewrites.
                        if (stateElement['defaultChecked'] && !authoredDefaultsDict[stateElementKey]) {
                            authoredDefaultsDict[stateElementKey] = stateElementValueKey;
                        }

                        changeSubscriptions.push(new Subscription('change', stateElement, stateChangeHandler));
                    }
                }

                nameRadioGroups(triggersByKey);

                // Hash-described keys keep what the hash says; authored
                // defaults fill the rest.
                initialState = withAuthoredDefaults(deserializeState());
                if (!$keys(initialState).length) {
                    return;
                }
                // The resolved selection owns every declared trigger: a
                // competing authored default must be unchecked
                // explicitly — unnamed radios never uncheck one another.
                initialTriggerKeys = $keys(stateTriggerElementsDict);
                initialTriggerKeysLength = initialTriggerKeys.length;
                while (initialTriggerKeysLength--) {
                    initialTriggerKey = initialTriggerKeys[initialTriggerKeysLength];
                    if (initialState[initialTriggerKey]) {
                        checkTriggers(initialTriggerKey, initialState[initialTriggerKey]);
                    }
                }
                updateMultiState(initialState);
            },

            // The original initialize(force), kept as an inherited public
            // member: without force it does nothing once bound; with
            // force it re-scans the document.
            initialize = function (force) {
                if (initialized && !force) {
                    return;
                }
                if (initialized) {
                    release();
                }
                initialized = true;
                bind();
                // No usable declarations means no feature — a page whose
                // declarations are all malformed or absent keeps its
                // history listeners unclaimed. Once bound they live as
                // long as the page.
                if (usableDeclarations && !historySubscriptions) {
                    historySubscriptions = [
                        new Subscription(POP_STATE, $w, genericStateChangeHandler),
                        new Subscription(HASH_CHANGE, $w, genericStateChangeHandler)
                    ];
                }
            };

        initialize();

        module['initialize'] = initialize;
        module['events'] = {};
        module['events'][statePopEvent['getEventName']()] = statePopEvent;
        // A live reference would let a caller rewrite the module's
        // working state — hand back a snapshot.
        module['getCurrentState'] = function () {
            return plainCopy(stateValueSelectedDict);
        };
        module['serializeState'] = serializeState;
        module['deserializeState'] = function (stateString) {
            return plainCopy(deserializeState(stateString));
        };
        return module;
    }
);
