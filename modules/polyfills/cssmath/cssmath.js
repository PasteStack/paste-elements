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

/*jslint browser:true plusplus:true sub:true unparam:true */
/*globals paste */

/**
 * Declared `data-paste-ui-polyfills-cssmath-<function>="<property>: <arg>,
 * <arg>, ..."` attributes use a CSS math function where the browser does not
 * support the authored declaration. The functions are min, max, clamp, round,
 * mod, rem, sin, cos, tan, asin, acos, atan, atan2, pow, sqrt, hypot, log,
 * exp, abs, sign, progress, and random. The attribute repeats a declaration
 * the page also writes natively, after its fallback, so an engine with the
 * function keeps its own.
 *
 * Arguments share one CSS unit or are unitless. `round` accepts an optional
 * leading strategy: `nearest`, `up`, `down`, or `to-zero`.
 * Percentages are left to the stylesheet: CSS Values 4 §10.10.1 compares
 * them only once resolved, as they "might resolve against a negative basis",
 * and the module does not know that basis.
 * The unitless CSS calc keywords `e`, `pi`, `infinity`, `-infinity`, and `NaN`
 * are matched without regard to ASCII case.
 *
 * `CSS.supports` is asked once for each distinct property and declaration
 * text, and a natively supported declaration is left to the browser.
 * Otherwise, a finite result is written once to the inline style with
 * `setProperty`. NaN is written as 0 with its result unit. Infinities and
 * exponent-form results whose absolute value is at least 1 are left to the
 * stylesheet; exponent-form results below 1 are written as 0.
 *
 * The inline value outranks every normal stylesheet declaration of the
 * property, as an authored `style` attribute does, including one in a
 * matching media query; animations and transitions still apply over it. A
 * stylesheet rule that must still win is declared `!important`; an engine
 * with the function applies it the same way. Custom properties are not
 * supported: `CSS.supports` accepts any value for one, so it cannot report
 * the function missing.
 *
 * Invalid declarations are left untouched. `random` draws once for each
 * element and attribute it evaluates. Attributes are bound once, when the
 * module is defined; it adds no listeners and exposes no control API.
 *
 * CSS Values 4: https://drafts.csswg.org/css-values-4/#math
 * CSS Values 5: https://drafts.csswg.org/css-values-5/#progress
 * CSS Values 5: https://drafts.csswg.org/css-values-5/#randomness
 *
 * @example
 *     <div style="width: 150px; width: random(100px, 200px, 10px)"
 *         data-paste-ui-polyfills-cssmath-random="width: 100px, 200px, 10px"></div>
 *
 * @module paste/ui/polyfills/cssmath
 */
paste['define']('paste.ui.polyfills.cssmath', [], function (cssmath) {
    'use strict';

    var $w = window,
        $doc = document,
        $math = Math,
        $Number = Number,
        $isNaN = isNaN,
        $String = String,
        $abs = $math['abs'],
        $acos = $math['acos'],
        $asin = $math['asin'],
        $atan = $math['atan'],
        $atan2 = $math['atan2'],
        $ceil = $math['ceil'],
        $cos = $math['cos'],
        $exp = $math['exp'],
        $floor = $math['floor'],
        $log = $math['log'],
        $max = $math['max'],
        $min = $math['min'],
        $pow = $math['pow'],
        $random = $math['random'],
        $sin = $math['sin'],
        $sqrt = $math['sqrt'],
        $tan = $math['tan'],
        $e = $math['E'],
        $minValue = $Number['MIN_VALUE'],
        $pi = $math['PI'],
        $infinity = Infinity,
        $nan = NaN,
        $css = $w['CSS'],
        PREFIX = 'data-paste-ui-polyfills-cssmath-',
        NAMES = [
            'min', 'max', 'clamp', 'round', 'mod', 'rem', 'sin', 'cos', 'tan',
            'asin', 'acos', 'atan', 'atan2', 'pow', 'sqrt', 'hypot', 'log',
            'exp', 'abs', 'sign', 'progress', 'random'
        ],
        NAME_COUNT = NAMES.length,
        ATTRIBUTES = [],
        SELECTOR,
        RULES = {
            'min': {'min': 1, 'max': $infinity, 'unit': 'any', 'result': null},
            'max': {'min': 1, 'max': $infinity, 'unit': 'any', 'result': null},
            'clamp': {'min': 3, 'max': 3, 'unit': 'any', 'result': null},
            'round': {'min': 1, 'max': 2, 'unit': 'any', 'result': null},
            'mod': {'min': 2, 'max': 2, 'unit': 'any', 'result': null},
            'rem': {'min': 2, 'max': 2, 'unit': 'any', 'result': null},
            'sin': {'min': 1, 'max': 1, 'unit': 'angle', 'result': ''},
            'cos': {'min': 1, 'max': 1, 'unit': 'angle', 'result': ''},
            'tan': {'min': 1, 'max': 1, 'unit': 'angle', 'result': ''},
            'asin': {'min': 1, 'max': 1, 'unit': 'number', 'result': 'rad'},
            'acos': {'min': 1, 'max': 1, 'unit': 'number', 'result': 'rad'},
            'atan': {'min': 1, 'max': 1, 'unit': 'number', 'result': 'rad'},
            'atan2': {'min': 2, 'max': 2, 'unit': 'any', 'result': 'rad'},
            'pow': {'min': 2, 'max': 2, 'unit': 'number', 'result': null},
            'sqrt': {'min': 1, 'max': 1, 'unit': 'number', 'result': null},
            'hypot': {'min': 1, 'max': $infinity, 'unit': 'any', 'result': null},
            'log': {'min': 1, 'max': 2, 'unit': 'number', 'result': null},
            'exp': {'min': 1, 'max': 1, 'unit': 'number', 'result': null},
            'abs': {'min': 1, 'max': 1, 'unit': 'any', 'result': null},
            'sign': {'min': 1, 'max': 1, 'unit': 'any', 'result': ''},
            'progress': {'min': 3, 'max': 3, 'unit': 'any', 'result': ''},
            'random': {'min': 2, 'max': 3, 'unit': 'any', 'result': null}
        },
        KEYWORDS = {'e': $e, 'pi': $pi, 'infinity': $infinity, '-infinity': -$infinity, 'nan': $nan},
        PROPERTY = /^-?[A-Za-z][A-Za-z0-9\-]*$/,
        NUMBER = /^(?:([+\-]?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:e[+\-]?[0-9]+)?)|(-infinity|infinity|nan|e|pi))([a-z%]*)$/i,
        UNIT = /^(?:px|cm|mm|q|in|pc|pt|em|ex|cap|ch|ic|rem|rex|rcap|rch|ric|lh|rlh|vw|vh|vi|vb|vmin|vmax|svw|svh|svi|svb|svmin|svmax|lvw|lvh|lvi|lvb|lvmin|lvmax|dvw|dvh|dvi|dvb|dvmin|dvmax|cqw|cqh|cqi|cqb|cqmin|cqmax|deg|grad|rad|turn|s|ms|hz|khz|dpi|dpcm|dppx|x)$/,
        ANGLE_FACTORS = {
            'deg': $pi / 180,
            'grad': $pi / 200,
            'rad': 1,
            'turn': 2 * $pi
        },
        FUNCTIONS = {
            // Returns the smallest value. CSS Values 4 §10.2: The min() or
            // max() functions contain one or more comma-separated
            // calculations, and represent the smallest (most negative) or
            // largest (most positive) of them, respectively.
            'min': $min,

            // Returns the largest value. CSS Values 4 §10.2: The min() or
            // max() functions contain one or more comma-separated
            // calculations, and represent the smallest (most negative) or
            // largest (most positive) of them, respectively.
            'max': $max,

            // Clamps a value between a minimum and maximum. CSS Values 4
            // §10.2: That is, given clamp(MIN, VAL, MAX), it represents
            // exactly the same value as max(MIN, min(VAL, MAX)).
            'clamp': function (minimum, value, maximum) {
                return $max(minimum, $min(value, maximum));
            },

            // Rounds a value to a multiple of a step. CSS Values 4 §10.3: The
            // round(<rounding-strategy>?, A, B?) function contains an optional
            // rounding strategy, and two calculations A and B, and returns the
            // value of A, rounded according to the rounding strategy, to the
            // nearest integer multiple of B either above or below A. CSS
            // Values 4 §10.3.1: In round(A, B), if B is 0, the result is NaN.
            'round': function (strategy, a, b) {
                var step,
                    quotient,
                    remainder,
                    truncated,
                    lower,
                    upper;
                b = (b === undefined) ? 1 : b;
                if ($isNaN(b) || b === 0) {
                    return $nan;
                }
                if (a === $infinity || a === -$infinity) {
                    return (b === $infinity || b === -$infinity) ? $nan : a;
                }
                step = $abs(b);
                quotient = a / step;
                if (step !== $infinity && quotient !== $infinity &&
                        quotient !== -$infinity) {
                    lower = $floor(quotient) * step;
                    upper = $ceil(quotient) * step;
                    if (lower === upper) {
                        return a;
                    }
                } else {
                    remainder = a % step;
                    if (remainder === 0) {
                        return a;
                    }
                    truncated = a - remainder;
                    if (a < 0) {
                        upper = truncated;
                        lower = upper - step;
                    } else {
                        lower = truncated;
                        upper = lower + step;
                    }
                }
                if (strategy === 'up') {
                    return upper;
                }
                if (strategy === 'down') {
                    return lower;
                }
                if (strategy === 'to-zero') {
                    return (a < 0) ? upper : lower;
                }
                return (a - lower < upper - a) ? lower : upper;
            },

            // Returns the modulo of two values. CSS Values 4 §10.3: The
            // modulus functions mod(A, B) and rem(A, B) similarly contain two
            // calculations A and B, and return the difference between A and
            // the nearest integer multiple of B either above or below A. CSS
            // Values 4 §10.3.1: In mod(A, B) or rem(A, B), if B is 0, the
            // result is NaN.
            'mod': function (a, b) {
                var remainder,
                    negativeA,
                    negativeB;
                if (a === $infinity || a === -$infinity) {
                    return $nan;
                }
                if (b === $infinity || b === -$infinity) {
                    negativeA = a < 0;
                    negativeB = b < 0;
                    if ((negativeA && !negativeB) || (!negativeA && negativeB)) {
                        return $nan;
                    }
                    return a;
                }
                remainder = a % b;
                if ((remainder < 0 && b > 0) || (remainder > 0 && b < 0)) {
                    return remainder + b;
                }
                return remainder;
            },

            // Returns the remainder of two values. CSS Values 4 §10.3: The
            // modulus functions mod(A, B) and rem(A, B) similarly contain two
            // calculations A and B, and return the difference between A and
            // the nearest integer multiple of B either above or below A. CSS
            // Values 4 §10.3.1: In mod(A, B) or rem(A, B), if B is 0, the
            // result is NaN.
            'rem': function (a, b) {
                return a % b;
            },

            // Returns the sine of an angle in radians. CSS Values 4 §10.4: The
            // sin(A), cos(A), and tan(A) functions all contain a single
            // calculation which must resolve to either a <number> or an
            // <angle>, and compute their corresponding function by
            // interpreting the result of their argument as radians.
            'sin': $sin,

            // Returns the cosine of an angle in radians. CSS Values 4 §10.4:
            // The sin(A), cos(A), and tan(A) functions all contain a single
            // calculation which must resolve to either a <number> or an
            // <angle>, and compute their corresponding function by
            // interpreting the result of their argument as radians.
            'cos': $cos,

            // Returns the tangent of an angle in radians. CSS Values 4 §10.4:
            // The sin(A), cos(A), and tan(A) functions all contain a single
            // calculation which must resolve to either a <number> or an
            // <angle>, and compute their corresponding function by
            // interpreting the result of their argument as radians.
            'tan': $tan,

            // Returns the arcsine in radians. CSS Values 4 §10.4: The asin(A),
            // acos(A), and atan(A) functions are the "arc" or "inverse"
            // trigonometric functions, representing the inverse function to
            // their corresponding "normal" trig functions.
            'asin': $asin,

            // Returns the arccosine in radians. CSS Values 4 §10.4: The
            // asin(A), acos(A), and atan(A) functions are the "arc" or
            // "inverse" trigonometric functions, representing the inverse
            // function to their corresponding "normal" trig functions.
            'acos': $acos,

            // Returns the arctangent in radians. CSS Values 4 §10.4: The
            // asin(A), acos(A), and atan(A) functions are the "arc" or
            // "inverse" trigonometric functions, representing the inverse
            // function to their corresponding "normal" trig functions.
            'atan': $atan,

            // Returns the arctangent of y and x in radians. CSS Values 4
            // §10.4: The function returns the <angle> between the positive
            // X-axis and the point (B,A), with the return type made consistent
            // with the input calculation’s type.
            'atan2': $atan2,

            // Raises a value to a power. CSS Values 4 §10.5: The pow(A, B)
            // function contains two comma-separated calculations A and B, both
            // of which must resolve to <number>s, and returns the result of
            // raising A to the power of B, returning the value as a <number>.
            // Math.pow(NaN, 0) returns 1, unlike the CSS function.
            'pow': function (a, b) {
                return ($isNaN(a)) ? $nan : $pow(a, b);
            },

            // Returns the square root of a value. CSS Values 4 §10.5: The
            // sqrt(A) function contains a single calculation which must
            // resolve to a <number>, and returns the square root of the value
            // as a <number>, with the return type made consistent with the
            // input calculation’s type.
            'sqrt': $sqrt,

            // Returns the square root of the sum of squared values. CSS Values
            // 4 §10.5: The hypot(A, …) function contains one or more
            // comma-separated calculations, and returns the length of an
            // N-dimensional vector with components equal to each of the
            // calculations. Math.hypot is not part of ES5.
            'hypot': function () {
                var valueIndex = arguments.length,
                    value,
                    ratio,
                    maximum = 0,
                    sum = 0,
                    hasInfinity = false;
                while (valueIndex--) {
                    value = arguments[valueIndex];
                    if ($isNaN(value)) {
                        return $nan;
                    }
                    value = $abs(value);
                    if (value === $infinity) {
                        hasInfinity = true;
                    } else if (value > maximum) {
                        ratio = maximum / value;
                        sum = sum * ratio * ratio + 1;
                        maximum = value;
                    } else if (value !== 0) {
                        ratio = value / maximum;
                        sum += ratio * ratio;
                    }
                }
                if (hasInfinity) {
                    return $infinity;
                }
                return maximum * $sqrt(sum);
            },

            // Returns the logarithm of a value. CSS Values 4 §10.5: The log(A,
            // B?) function contains one or two calculations (representing the
            // value to be logarithmed, and the base of the logarithm,
            // defaulting to e), which must resolve to <number>s, and returns
            // the logarithm base B of the value A, as a <number> with the
            // return type made consistent with the input calculation’s type.
            // CSS Values 4 §10.5.1: In log(A, B), if B is 1 or negative, the
            // result is NaN. CSS Values 4 §10.5.1: B values between 0 and 1,
            // or greater than 1, are valid. CSS Values 4 §10.5.1: If A is
            // negative, the result is NaN. If A is 0⁺ or 0⁻, the result is
            // −∞. If A is 1, the result is 0⁺. If A is +∞, the result is +∞.
            'log': function (a, base) {
                if ((base !== undefined && $isNaN(base)) || base <= 0 || base === 1) {
                    return $nan;
                }
                if (a === 0) {
                    return -$infinity;
                }
                if (a === 1) {
                    return 0;
                }
                if (a === $infinity) {
                    return $infinity;
                }
                return (base === undefined) ? $log(a) : $log(a) / $log(base);
            },

            // Returns e raised to a value. CSS Values 4 §10.5: The exp(A)
            // function contains one calculation which must resolve to a
            // <number>, and returns the same value as pow(e, A) as a <number>
            // with the return type made consistent with the input
            // calculation’s type.
            'exp': $exp,

            // Returns the absolute value. CSS Values 4 §10.6: The abs(A)
            // function contains one calculation A, and returns the absolute
            // value of A, as the same type as the input: if A’s numeric value
            // is positive or 0⁺, just A again; otherwise -1 * A.
            'abs': $abs,

            // Returns the sign of a value. CSS Values 4 §10.6: The sign(A)
            // function contains one calculation A, and returns -1 if A’s
            // numeric value is negative, +1 if A’s numeric value is positive,
            // 0⁺ if A’s numeric value is 0⁺, and 0⁻ if A’s numeric value is
            // 0⁻. Math.sign gives this result and is used where the engine
            // provides it.
            'sign': $math['sign'] || function (value) {
                return (value > 0) ? 1 : ((value < 0) ? -1 : value);
            },

            // Returns the clamped progress from start to end. CSS Values 5 §5:
            // The progress() functional notation represents the proportional
            // distance of a given value (the progress value) from one value
            // (the progress start value) to another value (the progress end
            // value), each represented as a calculation. CSS Values 5 §5: If
            // the progress start value and progress end value are the same
            // value, 0 if no-clamp is not specified.
            'progress': function (value, start, end) {
                if (start === end) {
                    return ($isNaN(value)) ? $nan : 0;
                }
                return $max(0, $min(1, (value - start) / (end - start)));
            },

            // Returns a random value in a range. CSS Values 5 §9.3: Let
            // epsilon be step / 1000, or the smallest representable value
            // greater than zero in the numeric type being used if epsilon
            // would round to zero. CSS Values 5 §9.1.1: If C is negative,
            // zero, or positive but close enough to zero that the range for
            // the step multiplier (the N mentioned in §9.3 Evaluating Random
            // Values) would be infinite in the user agent, the step must be
            // ignored.
            'random': function (randomBase, minimum, maximum, step) {
                var range,
                    epsilon,
                    n,
                    value,
                    stepIndex;
                if ($isNaN(maximum) || (step !== undefined && $isNaN(step))) {
                    return $nan;
                }
                if (minimum === $infinity || minimum === -$infinity) {
                    return minimum;
                }
                range = maximum - minimum;
                if (range === $infinity || range === -$infinity) {
                    return $nan;
                }
                if (range < 0) {
                    range = 0;
                    maximum = minimum;
                }
                if (step === $infinity || step === -$infinity) {
                    return minimum;
                }
                n = (step > 0) ? range / step : $infinity;
                if (n === $infinity) {
                    return minimum + randomBase * range;
                }
                epsilon = (step / 1000) || $minValue;
                n = $floor(n);
                if ($abs(minimum + n * step - maximum) > epsilon &&
                        $abs(minimum + (n + 1) * step - maximum) <= epsilon) {
                    n += 1;
                }
                stepIndex = $floor(randomBase * (n + 1));
                value = minimum + stepIndex * step;
                if (stepIndex === n && $abs(value - maximum) <= epsilon) {
                    return maximum;
                }
                return value;
            }
        },
        supported = !!($css && typeof $css['supports'] === 'function'),
        supportCache = {},
        functionIndex,
        elements,
        elementIndex,
        element,
        name,
        rule,
        ruleUnit,
        attribute,
        declaration,
        separator,
        property,
        argumentText,
        parts,
        first,
        strategy,
        count,
        values,
        unit,
        atom,
        match,
        keyword,
        number,
        valueUnit,
        argumentIndex,
        offset,
        probe,
        key,
        factor,
        result,
        resultUnit,
        valid,
        text;

    functionIndex = NAME_COUNT;
    while (functionIndex--) {
        ATTRIBUTES[functionIndex] = PREFIX + NAMES[functionIndex];
    }
    SELECTOR = '[' + ATTRIBUTES['join']('],[') + ']';

    elements = $doc['querySelectorAll'](SELECTOR);
    elementIndex = elements.length;
    while (elementIndex--) {
        element = elements[elementIndex];
        functionIndex = NAME_COUNT;
        while (functionIndex--) {
            name = NAMES[functionIndex];
            attribute = ATTRIBUTES[functionIndex];
            declaration = element['getAttribute'](attribute);
            if (declaration !== null) {
                rule = RULES[name];
                ruleUnit = rule['unit'];
                offset = (name === 'round' || name === 'random') ? 1 : 0;
                separator = declaration['indexOf'](':');
                valid = separator > 0;
                if (valid) {
                    property = declaration['slice'](0, separator)['trim']();
                    valid = PROPERTY['test'](property);
                }
                if (valid) {
                    property = property['toLowerCase']();
                    argumentText = declaration['slice'](separator + 1)['trim']();
                    valid = argumentText !== '';
                }
                if (valid && supported) {
                    probe = name + '(' + argumentText + ')';
                    key = property + '|' + probe;
                    if (supportCache[key] === undefined) {
                        supportCache[key] = $css['supports'](property, probe);
                    }
                    valid = !supportCache[key];
                }
                if (valid) {
                    parts = argumentText['split'](',');
                    first = 0;
                    strategy = undefined;
                    if (name === 'round') {
                        strategy = parts[0]['trim']()['toLowerCase']();
                        if (strategy === 'nearest' || strategy === 'up' ||
                                strategy === 'down' || strategy === 'to-zero') {
                            first = 1;
                        } else {
                            strategy = undefined;
                        }
                    }
                    count = parts.length - first;
                    valid = count >= rule['min'] && count <= rule['max'];
                }
                if (valid) {
                    values = [];
                    unit = undefined;
                    argumentIndex = count;
                    while (valid && argumentIndex--) {
                        atom = parts[argumentIndex + first]['trim']();
                        match = NUMBER['exec'](atom);
                        if (!match) {
                            valid = false;
                        }
                        if (valid) {
                            valueUnit = match[3]['toLowerCase']();
                            if (unit === undefined) {
                                unit = valueUnit;
                            } else if (valueUnit !== unit) {
                                valid = false;
                            }
                        }
                        if (valid) {
                            if (match[1] !== undefined) {
                                number = $Number(match[1]);
                                // A -0 literal is the unsigned zero.
                                if (number === 0) {
                                    number = 0;
                                }
                            } else {
                                keyword = match[2]['toLowerCase']();
                                number = KEYWORDS[keyword];
                                valid = valueUnit === '';
                            }
                            if (valid) {
                                values[argumentIndex + offset] = number;
                            }
                        }
                    }
                }
                if (valid && ruleUnit === 'number' && unit !== '') {
                    valid = false;
                }
                if (valid && unit !== '' && !UNIT['test'](unit)) {
                    valid = false;
                }
                if (valid && ruleUnit === 'angle' && unit !== '') {
                    factor = ANGLE_FACTORS[unit];
                    if (factor === undefined) {
                        valid = false;
                    } else {
                        values[offset] *= factor;
                    }
                }
                if (valid && name === 'round') {
                    if (count === 1 && unit !== '') {
                        valid = false;
                    } else {
                        values[0] = strategy;
                    }
                }
                if (valid) {
                    if (name === 'random') {
                        values[0] = $random();
                    }
                    result = FUNCTIONS[name]['apply'](null, values);
                    resultUnit = (rule['result'] === null) ? unit : rule['result'];
                    if ($isNaN(result)) {
                        text = '0';
                    } else if (result === $infinity || result === -$infinity) {
                        valid = false;
                    } else {
                        text = $String(result);
                        if (text['indexOf']('e') !== -1) {
                            if ($abs(result) >= 1) {
                                valid = false;
                            } else {
                                text = '0';
                            }
                        }
                    }
                }
                if (valid) {
                    element['style']['setProperty'](property, text + resultUnit);
                }
            }
        }
    }
});
