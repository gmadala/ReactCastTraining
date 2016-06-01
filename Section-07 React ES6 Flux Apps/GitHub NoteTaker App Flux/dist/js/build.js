(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);throw new Error("Cannot find module '"+o+"'")}var f=n[o]={exports:{}};t[o][0].call(f.exports,function(e){var n=t[o][1][e];return s(n?n:e)},f,f.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule AutoFocusMixin
 * @typechecks static-only
 */

"use strict";

var focusNode = require("./focusNode");

var AutoFocusMixin = {
  componentDidMount: function() {
    if (this.props.autoFocus) {
      focusNode(this.getDOMNode());
    }
  }
};

module.exports = AutoFocusMixin;

},{"./focusNode":111}],2:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule BeforeInputEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var SyntheticInputEvent = require("./SyntheticInputEvent");

var keyOf = require("./keyOf");

var canUseTextInputEvent = (
  ExecutionEnvironment.canUseDOM &&
  'TextEvent' in window &&
  !('documentMode' in document || isPresto())
);

/**
 * Opera <= 12 includes TextEvent in window, but does not fire
 * text input events. Rely on keypress instead.
 */
function isPresto() {
  var opera = window.opera;
  return (
    typeof opera === 'object' &&
    typeof opera.version === 'function' &&
    parseInt(opera.version(), 10) <= 12
  );
}

var SPACEBAR_CODE = 32;
var SPACEBAR_CHAR = String.fromCharCode(SPACEBAR_CODE);

var topLevelTypes = EventConstants.topLevelTypes;

// Events and their corresponding property names.
var eventTypes = {
  beforeInput: {
    phasedRegistrationNames: {
      bubbled: keyOf({onBeforeInput: null}),
      captured: keyOf({onBeforeInputCapture: null})
    },
    dependencies: [
      topLevelTypes.topCompositionEnd,
      topLevelTypes.topKeyPress,
      topLevelTypes.topTextInput,
      topLevelTypes.topPaste
    ]
  }
};

// Track characters inserted via keypress and composition events.
var fallbackChars = null;

// Track whether we've ever handled a keypress on the space key.
var hasSpaceKeypress = false;

/**
 * Return whether a native keypress event is assumed to be a command.
 * This is required because Firefox fires `keypress` events for key commands
 * (cut, copy, select-all, etc.) even though no character is inserted.
 */
function isKeypressCommand(nativeEvent) {
  return (
    (nativeEvent.ctrlKey || nativeEvent.altKey || nativeEvent.metaKey) &&
    // ctrlKey && altKey is equivalent to AltGr, and is not a command.
    !(nativeEvent.ctrlKey && nativeEvent.altKey)
  );
}

/**
 * Create an `onBeforeInput` event to match
 * http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105/#events-inputevents.
 *
 * This event plugin is based on the native `textInput` event
 * available in Chrome, Safari, Opera, and IE. This event fires after
 * `onKeyPress` and `onCompositionEnd`, but before `onInput`.
 *
 * `beforeInput` is spec'd but not implemented in any browsers, and
 * the `input` event does not provide any useful information about what has
 * actually been added, contrary to the spec. Thus, `textInput` is the best
 * available event to identify the characters that have actually been inserted
 * into the target node.
 */
var BeforeInputEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var chars;

    if (canUseTextInputEvent) {
      switch (topLevelType) {
        case topLevelTypes.topKeyPress:
          /**
           * If native `textInput` events are available, our goal is to make
           * use of them. However, there is a special case: the spacebar key.
           * In Webkit, preventing default on a spacebar `textInput` event
           * cancels character insertion, but it *also* causes the browser
           * to fall back to its default spacebar behavior of scrolling the
           * page.
           *
           * Tracking at:
           * https://code.google.com/p/chromium/issues/detail?id=355103
           *
           * To avoid this issue, use the keypress event as if no `textInput`
           * event is available.
           */
          var which = nativeEvent.which;
          if (which !== SPACEBAR_CODE) {
            return;
          }

          hasSpaceKeypress = true;
          chars = SPACEBAR_CHAR;
          break;

        case topLevelTypes.topTextInput:
          // Record the characters to be added to the DOM.
          chars = nativeEvent.data;

          // If it's a spacebar character, assume that we have already handled
          // it at the keypress level and bail immediately. Android Chrome
          // doesn't give us keycodes, so we need to blacklist it.
          if (chars === SPACEBAR_CHAR && hasSpaceKeypress) {
            return;
          }

          // Otherwise, carry on.
          break;

        default:
          // For other native event types, do nothing.
          return;
      }
    } else {
      switch (topLevelType) {
        case topLevelTypes.topPaste:
          // If a paste event occurs after a keypress, throw out the input
          // chars. Paste events should not lead to BeforeInput events.
          fallbackChars = null;
          break;
        case topLevelTypes.topKeyPress:
          /**
           * As of v27, Firefox may fire keypress events even when no character
           * will be inserted. A few possibilities:
           *
           * - `which` is `0`. Arrow keys, Esc key, etc.
           *
           * - `which` is the pressed key code, but no char is available.
           *   Ex: 'AltGr + d` in Polish. There is no modified character for
           *   this key combination and no character is inserted into the
           *   document, but FF fires the keypress for char code `100` anyway.
           *   No `input` event will occur.
           *
           * - `which` is the pressed key code, but a command combination is
           *   being used. Ex: `Cmd+C`. No character is inserted, and no
           *   `input` event will occur.
           */
          if (nativeEvent.which && !isKeypressCommand(nativeEvent)) {
            fallbackChars = String.fromCharCode(nativeEvent.which);
          }
          break;
        case topLevelTypes.topCompositionEnd:
          fallbackChars = nativeEvent.data;
          break;
      }

      // If no changes have occurred to the fallback string, no relevant
      // event has fired and we're done.
      if (fallbackChars === null) {
        return;
      }

      chars = fallbackChars;
    }

    // If no characters are being inserted, no BeforeInput event should
    // be fired.
    if (!chars) {
      return;
    }

    var event = SyntheticInputEvent.getPooled(
      eventTypes.beforeInput,
      topLevelTargetID,
      nativeEvent
    );

    event.data = chars;
    fallbackChars = null;
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }
};

module.exports = BeforeInputEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./SyntheticInputEvent":89,"./keyOf":133}],3:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CSSProperty
 */

"use strict";

/**
 * CSS properties which accept numbers but are not in units of "px".
 */
var isUnitlessNumber = {
  columnCount: true,
  flex: true,
  flexGrow: true,
  flexShrink: true,
  fontWeight: true,
  lineClamp: true,
  lineHeight: true,
  opacity: true,
  order: true,
  orphans: true,
  widows: true,
  zIndex: true,
  zoom: true,

  // SVG-related properties
  fillOpacity: true,
  strokeOpacity: true
};

/**
 * @param {string} prefix vendor-specific prefix, eg: Webkit
 * @param {string} key style name, eg: transitionDuration
 * @return {string} style name prefixed with `prefix`, properly camelCased, eg:
 * WebkitTransitionDuration
 */
function prefixKey(prefix, key) {
  return prefix + key.charAt(0).toUpperCase() + key.substring(1);
}

/**
 * Support style names that may come passed in prefixed by adding permutations
 * of vendor prefixes.
 */
var prefixes = ['Webkit', 'ms', 'Moz', 'O'];

// Using Object.keys here, or else the vanilla for-in loop makes IE8 go into an
// infinite loop, because it iterates over the newly added props too.
Object.keys(isUnitlessNumber).forEach(function(prop) {
  prefixes.forEach(function(prefix) {
    isUnitlessNumber[prefixKey(prefix, prop)] = isUnitlessNumber[prop];
  });
});

/**
 * Most style properties can be unset by doing .style[prop] = '' but IE8
 * doesn't like doing that with shorthand properties so for the properties that
 * IE8 breaks on, which are listed here, we instead unset each of the
 * individual properties. See http://bugs.jquery.com/ticket/12385.
 * The 4-value 'clock' properties like margin, padding, border-width seem to
 * behave without any problems. Curiously, list-style works too without any
 * special prodding.
 */
var shorthandPropertyExpansions = {
  background: {
    backgroundImage: true,
    backgroundPosition: true,
    backgroundRepeat: true,
    backgroundColor: true
  },
  border: {
    borderWidth: true,
    borderStyle: true,
    borderColor: true
  },
  borderBottom: {
    borderBottomWidth: true,
    borderBottomStyle: true,
    borderBottomColor: true
  },
  borderLeft: {
    borderLeftWidth: true,
    borderLeftStyle: true,
    borderLeftColor: true
  },
  borderRight: {
    borderRightWidth: true,
    borderRightStyle: true,
    borderRightColor: true
  },
  borderTop: {
    borderTopWidth: true,
    borderTopStyle: true,
    borderTopColor: true
  },
  font: {
    fontStyle: true,
    fontVariant: true,
    fontWeight: true,
    fontSize: true,
    lineHeight: true,
    fontFamily: true
  }
};

var CSSProperty = {
  isUnitlessNumber: isUnitlessNumber,
  shorthandPropertyExpansions: shorthandPropertyExpansions
};

module.exports = CSSProperty;

},{}],4:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CSSPropertyOperations
 * @typechecks static-only
 */

"use strict";

var CSSProperty = require("./CSSProperty");
var ExecutionEnvironment = require("./ExecutionEnvironment");

var camelizeStyleName = require("./camelizeStyleName");
var dangerousStyleValue = require("./dangerousStyleValue");
var hyphenateStyleName = require("./hyphenateStyleName");
var memoizeStringOnly = require("./memoizeStringOnly");
var warning = require("./warning");

var processStyleName = memoizeStringOnly(function(styleName) {
  return hyphenateStyleName(styleName);
});

var styleFloatAccessor = 'cssFloat';
if (ExecutionEnvironment.canUseDOM) {
  // IE8 only supports accessing cssFloat (standard) as styleFloat
  if (document.documentElement.style.cssFloat === undefined) {
    styleFloatAccessor = 'styleFloat';
  }
}

if ("production" !== process.env.NODE_ENV) {
  var warnedStyleNames = {};

  var warnHyphenatedStyleName = function(name) {
    if (warnedStyleNames.hasOwnProperty(name) && warnedStyleNames[name]) {
      return;
    }

    warnedStyleNames[name] = true;
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'Unsupported style property ' + name + '. Did you mean ' +
      camelizeStyleName(name) + '?'
    ) : null);
  };
}

/**
 * Operations for dealing with CSS properties.
 */
var CSSPropertyOperations = {

  /**
   * Serializes a mapping of style properties for use as inline styles:
   *
   *   > createMarkupForStyles({width: '200px', height: 0})
   *   "width:200px;height:0;"
   *
   * Undefined values are ignored so that declarative programming is easier.
   * The result should be HTML-escaped before insertion into the DOM.
   *
   * @param {object} styles
   * @return {?string}
   */
  createMarkupForStyles: function(styles) {
    var serialized = '';
    for (var styleName in styles) {
      if (!styles.hasOwnProperty(styleName)) {
        continue;
      }
      if ("production" !== process.env.NODE_ENV) {
        if (styleName.indexOf('-') > -1) {
          warnHyphenatedStyleName(styleName);
        }
      }
      var styleValue = styles[styleName];
      if (styleValue != null) {
        serialized += processStyleName(styleName) + ':';
        serialized += dangerousStyleValue(styleName, styleValue) + ';';
      }
    }
    return serialized || null;
  },

  /**
   * Sets the value for multiple styles on a node.  If a value is specified as
   * '' (empty string), the corresponding style property will be unset.
   *
   * @param {DOMElement} node
   * @param {object} styles
   */
  setValueForStyles: function(node, styles) {
    var style = node.style;
    for (var styleName in styles) {
      if (!styles.hasOwnProperty(styleName)) {
        continue;
      }
      if ("production" !== process.env.NODE_ENV) {
        if (styleName.indexOf('-') > -1) {
          warnHyphenatedStyleName(styleName);
        }
      }
      var styleValue = dangerousStyleValue(styleName, styles[styleName]);
      if (styleName === 'float') {
        styleName = styleFloatAccessor;
      }
      if (styleValue) {
        style[styleName] = styleValue;
      } else {
        var expansion = CSSProperty.shorthandPropertyExpansions[styleName];
        if (expansion) {
          // Shorthand property that IE8 won't like unsetting, so unset each
          // component to placate it
          for (var individualStyleName in expansion) {
            style[individualStyleName] = '';
          }
        } else {
          style[styleName] = '';
        }
      }
    }
  }

};

module.exports = CSSPropertyOperations;

}).call(this,require("ngpmcQ"))
},{"./CSSProperty":3,"./ExecutionEnvironment":21,"./camelizeStyleName":100,"./dangerousStyleValue":105,"./hyphenateStyleName":124,"./memoizeStringOnly":135,"./warning":145,"ngpmcQ":176}],5:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CallbackQueue
 */

"use strict";

var PooledClass = require("./PooledClass");

var assign = require("./Object.assign");
var invariant = require("./invariant");

/**
 * A specialized pseudo-event module to help keep track of components waiting to
 * be notified when their DOM representations are available for use.
 *
 * This implements `PooledClass`, so you should never need to instantiate this.
 * Instead, use `CallbackQueue.getPooled()`.
 *
 * @class ReactMountReady
 * @implements PooledClass
 * @internal
 */
function CallbackQueue() {
  this._callbacks = null;
  this._contexts = null;
}

assign(CallbackQueue.prototype, {

  /**
   * Enqueues a callback to be invoked when `notifyAll` is invoked.
   *
   * @param {function} callback Invoked when `notifyAll` is invoked.
   * @param {?object} context Context to call `callback` with.
   * @internal
   */
  enqueue: function(callback, context) {
    this._callbacks = this._callbacks || [];
    this._contexts = this._contexts || [];
    this._callbacks.push(callback);
    this._contexts.push(context);
  },

  /**
   * Invokes all enqueued callbacks and clears the queue. This is invoked after
   * the DOM representation of a component has been created or updated.
   *
   * @internal
   */
  notifyAll: function() {
    var callbacks = this._callbacks;
    var contexts = this._contexts;
    if (callbacks) {
      ("production" !== process.env.NODE_ENV ? invariant(
        callbacks.length === contexts.length,
        "Mismatched list of contexts in callback queue"
      ) : invariant(callbacks.length === contexts.length));
      this._callbacks = null;
      this._contexts = null;
      for (var i = 0, l = callbacks.length; i < l; i++) {
        callbacks[i].call(contexts[i]);
      }
      callbacks.length = 0;
      contexts.length = 0;
    }
  },

  /**
   * Resets the internal queue.
   *
   * @internal
   */
  reset: function() {
    this._callbacks = null;
    this._contexts = null;
  },

  /**
   * `PooledClass` looks for this.
   */
  destructor: function() {
    this.reset();
  }

});

PooledClass.addPoolingTo(CallbackQueue);

module.exports = CallbackQueue;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./PooledClass":27,"./invariant":126,"ngpmcQ":176}],6:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ChangeEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var ReactUpdates = require("./ReactUpdates");
var SyntheticEvent = require("./SyntheticEvent");

var isEventSupported = require("./isEventSupported");
var isTextInputElement = require("./isTextInputElement");
var keyOf = require("./keyOf");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  change: {
    phasedRegistrationNames: {
      bubbled: keyOf({onChange: null}),
      captured: keyOf({onChangeCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topChange,
      topLevelTypes.topClick,
      topLevelTypes.topFocus,
      topLevelTypes.topInput,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyUp,
      topLevelTypes.topSelectionChange
    ]
  }
};

/**
 * For IE shims
 */
var activeElement = null;
var activeElementID = null;
var activeElementValue = null;
var activeElementValueProp = null;

/**
 * SECTION: handle `change` event
 */
function shouldUseChangeEvent(elem) {
  return (
    elem.nodeName === 'SELECT' ||
    (elem.nodeName === 'INPUT' && elem.type === 'file')
  );
}

var doesChangeEventBubble = false;
if (ExecutionEnvironment.canUseDOM) {
  // See `handleChange` comment below
  doesChangeEventBubble = isEventSupported('change') && (
    !('documentMode' in document) || document.documentMode > 8
  );
}

function manualDispatchChangeEvent(nativeEvent) {
  var event = SyntheticEvent.getPooled(
    eventTypes.change,
    activeElementID,
    nativeEvent
  );
  EventPropagators.accumulateTwoPhaseDispatches(event);

  // If change and propertychange bubbled, we'd just bind to it like all the
  // other events and have it go through ReactBrowserEventEmitter. Since it
  // doesn't, we manually listen for the events and so we have to enqueue and
  // process the abstract event manually.
  //
  // Batching is necessary here in order to ensure that all event handlers run
  // before the next rerender (including event handlers attached to ancestor
  // elements instead of directly on the input). Without this, controlled
  // components don't work properly in conjunction with event bubbling because
  // the component is rerendered and the value reverted before all the event
  // handlers can run. See https://github.com/facebook/react/issues/708.
  ReactUpdates.batchedUpdates(runEventInBatch, event);
}

function runEventInBatch(event) {
  EventPluginHub.enqueueEvents(event);
  EventPluginHub.processEventQueue();
}

function startWatchingForChangeEventIE8(target, targetID) {
  activeElement = target;
  activeElementID = targetID;
  activeElement.attachEvent('onchange', manualDispatchChangeEvent);
}

function stopWatchingForChangeEventIE8() {
  if (!activeElement) {
    return;
  }
  activeElement.detachEvent('onchange', manualDispatchChangeEvent);
  activeElement = null;
  activeElementID = null;
}

function getTargetIDForChangeEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topChange) {
    return topLevelTargetID;
  }
}
function handleEventsForChangeEventIE8(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topFocus) {
    // stopWatching() should be a noop here but we call it just in case we
    // missed a blur event somehow.
    stopWatchingForChangeEventIE8();
    startWatchingForChangeEventIE8(topLevelTarget, topLevelTargetID);
  } else if (topLevelType === topLevelTypes.topBlur) {
    stopWatchingForChangeEventIE8();
  }
}


/**
 * SECTION: handle `input` event
 */
var isInputEventSupported = false;
if (ExecutionEnvironment.canUseDOM) {
  // IE9 claims to support the input event but fails to trigger it when
  // deleting text, so we ignore its input events
  isInputEventSupported = isEventSupported('input') && (
    !('documentMode' in document) || document.documentMode > 9
  );
}

/**
 * (For old IE.) Replacement getter/setter for the `value` property that gets
 * set on the active element.
 */
var newValueProp =  {
  get: function() {
    return activeElementValueProp.get.call(this);
  },
  set: function(val) {
    // Cast to a string so we can do equality checks.
    activeElementValue = '' + val;
    activeElementValueProp.set.call(this, val);
  }
};

/**
 * (For old IE.) Starts tracking propertychange events on the passed-in element
 * and override the value property so that we can distinguish user events from
 * value changes in JS.
 */
function startWatchingForValueChange(target, targetID) {
  activeElement = target;
  activeElementID = targetID;
  activeElementValue = target.value;
  activeElementValueProp = Object.getOwnPropertyDescriptor(
    target.constructor.prototype,
    'value'
  );

  Object.defineProperty(activeElement, 'value', newValueProp);
  activeElement.attachEvent('onpropertychange', handlePropertyChange);
}

/**
 * (For old IE.) Removes the event listeners from the currently-tracked element,
 * if any exists.
 */
function stopWatchingForValueChange() {
  if (!activeElement) {
    return;
  }

  // delete restores the original property definition
  delete activeElement.value;
  activeElement.detachEvent('onpropertychange', handlePropertyChange);

  activeElement = null;
  activeElementID = null;
  activeElementValue = null;
  activeElementValueProp = null;
}

/**
 * (For old IE.) Handles a propertychange event, sending a `change` event if
 * the value of the active element has changed.
 */
function handlePropertyChange(nativeEvent) {
  if (nativeEvent.propertyName !== 'value') {
    return;
  }
  var value = nativeEvent.srcElement.value;
  if (value === activeElementValue) {
    return;
  }
  activeElementValue = value;

  manualDispatchChangeEvent(nativeEvent);
}

/**
 * If a `change` event should be fired, returns the target's ID.
 */
function getTargetIDForInputEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topInput) {
    // In modern browsers (i.e., not IE8 or IE9), the input event is exactly
    // what we want so fall through here and trigger an abstract event
    return topLevelTargetID;
  }
}

// For IE8 and IE9.
function handleEventsForInputEventIE(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topFocus) {
    // In IE8, we can capture almost all .value changes by adding a
    // propertychange handler and looking for events with propertyName
    // equal to 'value'
    // In IE9, propertychange fires for most input events but is buggy and
    // doesn't fire when text is deleted, but conveniently, selectionchange
    // appears to fire in all of the remaining cases so we catch those and
    // forward the event if the value has changed
    // In either case, we don't want to call the event handler if the value
    // is changed from JS so we redefine a setter for `.value` that updates
    // our activeElementValue variable, allowing us to ignore those changes
    //
    // stopWatching() should be a noop here but we call it just in case we
    // missed a blur event somehow.
    stopWatchingForValueChange();
    startWatchingForValueChange(topLevelTarget, topLevelTargetID);
  } else if (topLevelType === topLevelTypes.topBlur) {
    stopWatchingForValueChange();
  }
}

// For IE8 and IE9.
function getTargetIDForInputEventIE(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topSelectionChange ||
      topLevelType === topLevelTypes.topKeyUp ||
      topLevelType === topLevelTypes.topKeyDown) {
    // On the selectionchange event, the target is just document which isn't
    // helpful for us so just check activeElement instead.
    //
    // 99% of the time, keydown and keyup aren't necessary. IE8 fails to fire
    // propertychange on the first input event after setting `value` from a
    // script and fires only keydown, keypress, keyup. Catching keyup usually
    // gets it and catching keydown lets us fire an event for the first
    // keystroke if user does a key repeat (it'll be a little delayed: right
    // before the second keystroke). Other input methods (e.g., paste) seem to
    // fire selectionchange normally.
    if (activeElement && activeElement.value !== activeElementValue) {
      activeElementValue = activeElement.value;
      return activeElementID;
    }
  }
}


/**
 * SECTION: handle `click` event
 */
function shouldUseClickEvent(elem) {
  // Use the `click` event to detect changes to checkbox and radio inputs.
  // This approach works across all browsers, whereas `change` does not fire
  // until `blur` in IE8.
  return (
    elem.nodeName === 'INPUT' &&
    (elem.type === 'checkbox' || elem.type === 'radio')
  );
}

function getTargetIDForClickEvent(
    topLevelType,
    topLevelTarget,
    topLevelTargetID) {
  if (topLevelType === topLevelTypes.topClick) {
    return topLevelTargetID;
  }
}

/**
 * This plugin creates an `onChange` event that normalizes change events
 * across form elements. This event fires at a time when it's possible to
 * change the element's value without seeing a flicker.
 *
 * Supported elements are:
 * - input (see `isTextInputElement`)
 * - textarea
 * - select
 */
var ChangeEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var getTargetIDFunc, handleEventFunc;
    if (shouldUseChangeEvent(topLevelTarget)) {
      if (doesChangeEventBubble) {
        getTargetIDFunc = getTargetIDForChangeEvent;
      } else {
        handleEventFunc = handleEventsForChangeEventIE8;
      }
    } else if (isTextInputElement(topLevelTarget)) {
      if (isInputEventSupported) {
        getTargetIDFunc = getTargetIDForInputEvent;
      } else {
        getTargetIDFunc = getTargetIDForInputEventIE;
        handleEventFunc = handleEventsForInputEventIE;
      }
    } else if (shouldUseClickEvent(topLevelTarget)) {
      getTargetIDFunc = getTargetIDForClickEvent;
    }

    if (getTargetIDFunc) {
      var targetID = getTargetIDFunc(
        topLevelType,
        topLevelTarget,
        topLevelTargetID
      );
      if (targetID) {
        var event = SyntheticEvent.getPooled(
          eventTypes.change,
          targetID,
          nativeEvent
        );
        EventPropagators.accumulateTwoPhaseDispatches(event);
        return event;
      }
    }

    if (handleEventFunc) {
      handleEventFunc(
        topLevelType,
        topLevelTarget,
        topLevelTargetID
      );
    }
  }

};

module.exports = ChangeEventPlugin;

},{"./EventConstants":15,"./EventPluginHub":17,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactUpdates":79,"./SyntheticEvent":87,"./isEventSupported":127,"./isTextInputElement":129,"./keyOf":133}],7:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ClientReactRootIndex
 * @typechecks
 */

"use strict";

var nextReactRootIndex = 0;

var ClientReactRootIndex = {
  createReactRootIndex: function() {
    return nextReactRootIndex++;
  }
};

module.exports = ClientReactRootIndex;

},{}],8:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule CompositionEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var ReactInputSelection = require("./ReactInputSelection");
var SyntheticCompositionEvent = require("./SyntheticCompositionEvent");

var getTextContentAccessor = require("./getTextContentAccessor");
var keyOf = require("./keyOf");

var END_KEYCODES = [9, 13, 27, 32]; // Tab, Return, Esc, Space
var START_KEYCODE = 229;

var useCompositionEvent = (
  ExecutionEnvironment.canUseDOM &&
  'CompositionEvent' in window
);

// In IE9+, we have access to composition events, but the data supplied
// by the native compositionend event may be incorrect. In Korean, for example,
// the compositionend event contains only one character regardless of
// how many characters have been composed since compositionstart.
// We therefore use the fallback data while still using the native
// events as triggers.
var useFallbackData = (
  !useCompositionEvent ||
  (
    'documentMode' in document &&
    document.documentMode > 8 &&
    document.documentMode <= 11
  )
);

var topLevelTypes = EventConstants.topLevelTypes;
var currentComposition = null;

// Events and their corresponding property names.
var eventTypes = {
  compositionEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionEnd: null}),
      captured: keyOf({onCompositionEndCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionEnd,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  },
  compositionStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionStart: null}),
      captured: keyOf({onCompositionStartCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionStart,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  },
  compositionUpdate: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCompositionUpdate: null}),
      captured: keyOf({onCompositionUpdateCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topCompositionUpdate,
      topLevelTypes.topKeyDown,
      topLevelTypes.topKeyPress,
      topLevelTypes.topKeyUp,
      topLevelTypes.topMouseDown
    ]
  }
};

/**
 * Translate native top level events into event types.
 *
 * @param {string} topLevelType
 * @return {object}
 */
function getCompositionEventType(topLevelType) {
  switch (topLevelType) {
    case topLevelTypes.topCompositionStart:
      return eventTypes.compositionStart;
    case topLevelTypes.topCompositionEnd:
      return eventTypes.compositionEnd;
    case topLevelTypes.topCompositionUpdate:
      return eventTypes.compositionUpdate;
  }
}

/**
 * Does our fallback best-guess model think this event signifies that
 * composition has begun?
 *
 * @param {string} topLevelType
 * @param {object} nativeEvent
 * @return {boolean}
 */
function isFallbackStart(topLevelType, nativeEvent) {
  return (
    topLevelType === topLevelTypes.topKeyDown &&
    nativeEvent.keyCode === START_KEYCODE
  );
}

/**
 * Does our fallback mode think that this event is the end of composition?
 *
 * @param {string} topLevelType
 * @param {object} nativeEvent
 * @return {boolean}
 */
function isFallbackEnd(topLevelType, nativeEvent) {
  switch (topLevelType) {
    case topLevelTypes.topKeyUp:
      // Command keys insert or clear IME input.
      return (END_KEYCODES.indexOf(nativeEvent.keyCode) !== -1);
    case topLevelTypes.topKeyDown:
      // Expect IME keyCode on each keydown. If we get any other
      // code we must have exited earlier.
      return (nativeEvent.keyCode !== START_KEYCODE);
    case topLevelTypes.topKeyPress:
    case topLevelTypes.topMouseDown:
    case topLevelTypes.topBlur:
      // Events are not possible without cancelling IME.
      return true;
    default:
      return false;
  }
}

/**
 * Helper class stores information about selection and document state
 * so we can figure out what changed at a later date.
 *
 * @param {DOMEventTarget} root
 */
function FallbackCompositionState(root) {
  this.root = root;
  this.startSelection = ReactInputSelection.getSelection(root);
  this.startValue = this.getText();
}

/**
 * Get current text of input.
 *
 * @return {string}
 */
FallbackCompositionState.prototype.getText = function() {
  return this.root.value || this.root[getTextContentAccessor()];
};

/**
 * Text that has changed since the start of composition.
 *
 * @return {string}
 */
FallbackCompositionState.prototype.getData = function() {
  var endValue = this.getText();
  var prefixLength = this.startSelection.start;
  var suffixLength = this.startValue.length - this.startSelection.end;

  return endValue.substr(
    prefixLength,
    endValue.length - suffixLength - prefixLength
  );
};

/**
 * This plugin creates `onCompositionStart`, `onCompositionUpdate` and
 * `onCompositionEnd` events on inputs, textareas and contentEditable
 * nodes.
 */
var CompositionEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    var eventType;
    var data;

    if (useCompositionEvent) {
      eventType = getCompositionEventType(topLevelType);
    } else if (!currentComposition) {
      if (isFallbackStart(topLevelType, nativeEvent)) {
        eventType = eventTypes.compositionStart;
      }
    } else if (isFallbackEnd(topLevelType, nativeEvent)) {
      eventType = eventTypes.compositionEnd;
    }

    if (useFallbackData) {
      // The current composition is stored statically and must not be
      // overwritten while composition continues.
      if (!currentComposition && eventType === eventTypes.compositionStart) {
        currentComposition = new FallbackCompositionState(topLevelTarget);
      } else if (eventType === eventTypes.compositionEnd) {
        if (currentComposition) {
          data = currentComposition.getData();
          currentComposition = null;
        }
      }
    }

    if (eventType) {
      var event = SyntheticCompositionEvent.getPooled(
        eventType,
        topLevelTargetID,
        nativeEvent
      );
      if (data) {
        // Inject data generated from fallback path into the synthetic event.
        // This matches the property of native CompositionEventInterface.
        event.data = data;
      }
      EventPropagators.accumulateTwoPhaseDispatches(event);
      return event;
    }
  }
};

module.exports = CompositionEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ExecutionEnvironment":21,"./ReactInputSelection":59,"./SyntheticCompositionEvent":85,"./getTextContentAccessor":121,"./keyOf":133}],9:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMChildrenOperations
 * @typechecks static-only
 */

"use strict";

var Danger = require("./Danger");
var ReactMultiChildUpdateTypes = require("./ReactMultiChildUpdateTypes");

var getTextContentAccessor = require("./getTextContentAccessor");
var invariant = require("./invariant");

/**
 * The DOM property to use when setting text content.
 *
 * @type {string}
 * @private
 */
var textContentAccessor = getTextContentAccessor();

/**
 * Inserts `childNode` as a child of `parentNode` at the `index`.
 *
 * @param {DOMElement} parentNode Parent node in which to insert.
 * @param {DOMElement} childNode Child node to insert.
 * @param {number} index Index at which to insert the child.
 * @internal
 */
function insertChildAt(parentNode, childNode, index) {
  // By exploiting arrays returning `undefined` for an undefined index, we can
  // rely exclusively on `insertBefore(node, null)` instead of also using
  // `appendChild(node)`. However, using `undefined` is not allowed by all
  // browsers so we must replace it with `null`.
  parentNode.insertBefore(
    childNode,
    parentNode.childNodes[index] || null
  );
}

var updateTextContent;
if (textContentAccessor === 'textContent') {
  /**
   * Sets the text content of `node` to `text`.
   *
   * @param {DOMElement} node Node to change
   * @param {string} text New text content
   */
  updateTextContent = function(node, text) {
    node.textContent = text;
  };
} else {
  /**
   * Sets the text content of `node` to `text`.
   *
   * @param {DOMElement} node Node to change
   * @param {string} text New text content
   */
  updateTextContent = function(node, text) {
    // In order to preserve newlines correctly, we can't use .innerText to set
    // the contents (see #1080), so we empty the element then append a text node
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    if (text) {
      var doc = node.ownerDocument || document;
      node.appendChild(doc.createTextNode(text));
    }
  };
}

/**
 * Operations for updating with DOM children.
 */
var DOMChildrenOperations = {

  dangerouslyReplaceNodeWithMarkup: Danger.dangerouslyReplaceNodeWithMarkup,

  updateTextContent: updateTextContent,

  /**
   * Updates a component's children by processing a series of updates. The
   * update configurations are each expected to have a `parentNode` property.
   *
   * @param {array<object>} updates List of update configurations.
   * @param {array<string>} markupList List of markup strings.
   * @internal
   */
  processUpdates: function(updates, markupList) {
    var update;
    // Mapping from parent IDs to initial child orderings.
    var initialChildren = null;
    // List of children that will be moved or removed.
    var updatedChildren = null;

    for (var i = 0; update = updates[i]; i++) {
      if (update.type === ReactMultiChildUpdateTypes.MOVE_EXISTING ||
          update.type === ReactMultiChildUpdateTypes.REMOVE_NODE) {
        var updatedIndex = update.fromIndex;
        var updatedChild = update.parentNode.childNodes[updatedIndex];
        var parentID = update.parentID;

        ("production" !== process.env.NODE_ENV ? invariant(
          updatedChild,
          'processUpdates(): Unable to find child %s of element. This ' +
          'probably means the DOM was unexpectedly mutated (e.g., by the ' +
          'browser), usually due to forgetting a <tbody> when using tables, ' +
          'nesting tags like <form>, <p>, or <a>, or using non-SVG elements '+
          'in an <svg> parent. Try inspecting the child nodes of the element ' +
          'with React ID `%s`.',
          updatedIndex,
          parentID
        ) : invariant(updatedChild));

        initialChildren = initialChildren || {};
        initialChildren[parentID] = initialChildren[parentID] || [];
        initialChildren[parentID][updatedIndex] = updatedChild;

        updatedChildren = updatedChildren || [];
        updatedChildren.push(updatedChild);
      }
    }

    var renderedMarkup = Danger.dangerouslyRenderMarkup(markupList);

    // Remove updated children first so that `toIndex` is consistent.
    if (updatedChildren) {
      for (var j = 0; j < updatedChildren.length; j++) {
        updatedChildren[j].parentNode.removeChild(updatedChildren[j]);
      }
    }

    for (var k = 0; update = updates[k]; k++) {
      switch (update.type) {
        case ReactMultiChildUpdateTypes.INSERT_MARKUP:
          insertChildAt(
            update.parentNode,
            renderedMarkup[update.markupIndex],
            update.toIndex
          );
          break;
        case ReactMultiChildUpdateTypes.MOVE_EXISTING:
          insertChildAt(
            update.parentNode,
            initialChildren[update.parentID][update.fromIndex],
            update.toIndex
          );
          break;
        case ReactMultiChildUpdateTypes.TEXT_CONTENT:
          updateTextContent(
            update.parentNode,
            update.textContent
          );
          break;
        case ReactMultiChildUpdateTypes.REMOVE_NODE:
          // Already removed by the for-loop above.
          break;
      }
    }
  }

};

module.exports = DOMChildrenOperations;

}).call(this,require("ngpmcQ"))
},{"./Danger":12,"./ReactMultiChildUpdateTypes":65,"./getTextContentAccessor":121,"./invariant":126,"ngpmcQ":176}],10:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMProperty
 * @typechecks static-only
 */

/*jslint bitwise: true */

"use strict";

var invariant = require("./invariant");

function checkMask(value, bitmask) {
  return (value & bitmask) === bitmask;
}

var DOMPropertyInjection = {
  /**
   * Mapping from normalized, camelcased property names to a configuration that
   * specifies how the associated DOM property should be accessed or rendered.
   */
  MUST_USE_ATTRIBUTE: 0x1,
  MUST_USE_PROPERTY: 0x2,
  HAS_SIDE_EFFECTS: 0x4,
  HAS_BOOLEAN_VALUE: 0x8,
  HAS_NUMERIC_VALUE: 0x10,
  HAS_POSITIVE_NUMERIC_VALUE: 0x20 | 0x10,
  HAS_OVERLOADED_BOOLEAN_VALUE: 0x40,

  /**
   * Inject some specialized knowledge about the DOM. This takes a config object
   * with the following properties:
   *
   * isCustomAttribute: function that given an attribute name will return true
   * if it can be inserted into the DOM verbatim. Useful for data-* or aria-*
   * attributes where it's impossible to enumerate all of the possible
   * attribute names,
   *
   * Properties: object mapping DOM property name to one of the
   * DOMPropertyInjection constants or null. If your attribute isn't in here,
   * it won't get written to the DOM.
   *
   * DOMAttributeNames: object mapping React attribute name to the DOM
   * attribute name. Attribute names not specified use the **lowercase**
   * normalized name.
   *
   * DOMPropertyNames: similar to DOMAttributeNames but for DOM properties.
   * Property names not specified use the normalized name.
   *
   * DOMMutationMethods: Properties that require special mutation methods. If
   * `value` is undefined, the mutation method should unset the property.
   *
   * @param {object} domPropertyConfig the config as described above.
   */
  injectDOMPropertyConfig: function(domPropertyConfig) {
    var Properties = domPropertyConfig.Properties || {};
    var DOMAttributeNames = domPropertyConfig.DOMAttributeNames || {};
    var DOMPropertyNames = domPropertyConfig.DOMPropertyNames || {};
    var DOMMutationMethods = domPropertyConfig.DOMMutationMethods || {};

    if (domPropertyConfig.isCustomAttribute) {
      DOMProperty._isCustomAttributeFunctions.push(
        domPropertyConfig.isCustomAttribute
      );
    }

    for (var propName in Properties) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !DOMProperty.isStandardName.hasOwnProperty(propName),
        'injectDOMPropertyConfig(...): You\'re trying to inject DOM property ' +
        '\'%s\' which has already been injected. You may be accidentally ' +
        'injecting the same DOM property config twice, or you may be ' +
        'injecting two configs that have conflicting property names.',
        propName
      ) : invariant(!DOMProperty.isStandardName.hasOwnProperty(propName)));

      DOMProperty.isStandardName[propName] = true;

      var lowerCased = propName.toLowerCase();
      DOMProperty.getPossibleStandardName[lowerCased] = propName;

      if (DOMAttributeNames.hasOwnProperty(propName)) {
        var attributeName = DOMAttributeNames[propName];
        DOMProperty.getPossibleStandardName[attributeName] = propName;
        DOMProperty.getAttributeName[propName] = attributeName;
      } else {
        DOMProperty.getAttributeName[propName] = lowerCased;
      }

      DOMProperty.getPropertyName[propName] =
        DOMPropertyNames.hasOwnProperty(propName) ?
          DOMPropertyNames[propName] :
          propName;

      if (DOMMutationMethods.hasOwnProperty(propName)) {
        DOMProperty.getMutationMethod[propName] = DOMMutationMethods[propName];
      } else {
        DOMProperty.getMutationMethod[propName] = null;
      }

      var propConfig = Properties[propName];
      DOMProperty.mustUseAttribute[propName] =
        checkMask(propConfig, DOMPropertyInjection.MUST_USE_ATTRIBUTE);
      DOMProperty.mustUseProperty[propName] =
        checkMask(propConfig, DOMPropertyInjection.MUST_USE_PROPERTY);
      DOMProperty.hasSideEffects[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_SIDE_EFFECTS);
      DOMProperty.hasBooleanValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_BOOLEAN_VALUE);
      DOMProperty.hasNumericValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_NUMERIC_VALUE);
      DOMProperty.hasPositiveNumericValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_POSITIVE_NUMERIC_VALUE);
      DOMProperty.hasOverloadedBooleanValue[propName] =
        checkMask(propConfig, DOMPropertyInjection.HAS_OVERLOADED_BOOLEAN_VALUE);

      ("production" !== process.env.NODE_ENV ? invariant(
        !DOMProperty.mustUseAttribute[propName] ||
          !DOMProperty.mustUseProperty[propName],
        'DOMProperty: Cannot require using both attribute and property: %s',
        propName
      ) : invariant(!DOMProperty.mustUseAttribute[propName] ||
        !DOMProperty.mustUseProperty[propName]));
      ("production" !== process.env.NODE_ENV ? invariant(
        DOMProperty.mustUseProperty[propName] ||
          !DOMProperty.hasSideEffects[propName],
        'DOMProperty: Properties that have side effects must use property: %s',
        propName
      ) : invariant(DOMProperty.mustUseProperty[propName] ||
        !DOMProperty.hasSideEffects[propName]));
      ("production" !== process.env.NODE_ENV ? invariant(
        !!DOMProperty.hasBooleanValue[propName] +
          !!DOMProperty.hasNumericValue[propName] +
          !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1,
        'DOMProperty: Value can be one of boolean, overloaded boolean, or ' +
        'numeric value, but not a combination: %s',
        propName
      ) : invariant(!!DOMProperty.hasBooleanValue[propName] +
        !!DOMProperty.hasNumericValue[propName] +
        !!DOMProperty.hasOverloadedBooleanValue[propName] <= 1));
    }
  }
};
var defaultValueCache = {};

/**
 * DOMProperty exports lookup objects that can be used like functions:
 *
 *   > DOMProperty.isValid['id']
 *   true
 *   > DOMProperty.isValid['foobar']
 *   undefined
 *
 * Although this may be confusing, it performs better in general.
 *
 * @see http://jsperf.com/key-exists
 * @see http://jsperf.com/key-missing
 */
var DOMProperty = {

  ID_ATTRIBUTE_NAME: 'data-reactid',

  /**
   * Checks whether a property name is a standard property.
   * @type {Object}
   */
  isStandardName: {},

  /**
   * Mapping from lowercase property names to the properly cased version, used
   * to warn in the case of missing properties.
   * @type {Object}
   */
  getPossibleStandardName: {},

  /**
   * Mapping from normalized names to attribute names that differ. Attribute
   * names are used when rendering markup or with `*Attribute()`.
   * @type {Object}
   */
  getAttributeName: {},

  /**
   * Mapping from normalized names to properties on DOM node instances.
   * (This includes properties that mutate due to external factors.)
   * @type {Object}
   */
  getPropertyName: {},

  /**
   * Mapping from normalized names to mutation methods. This will only exist if
   * mutation cannot be set simply by the property or `setAttribute()`.
   * @type {Object}
   */
  getMutationMethod: {},

  /**
   * Whether the property must be accessed and mutated as an object property.
   * @type {Object}
   */
  mustUseAttribute: {},

  /**
   * Whether the property must be accessed and mutated using `*Attribute()`.
   * (This includes anything that fails `<propName> in <element>`.)
   * @type {Object}
   */
  mustUseProperty: {},

  /**
   * Whether or not setting a value causes side effects such as triggering
   * resources to be loaded or text selection changes. We must ensure that
   * the value is only set if it has changed.
   * @type {Object}
   */
  hasSideEffects: {},

  /**
   * Whether the property should be removed when set to a falsey value.
   * @type {Object}
   */
  hasBooleanValue: {},

  /**
   * Whether the property must be numeric or parse as a
   * numeric and should be removed when set to a falsey value.
   * @type {Object}
   */
  hasNumericValue: {},

  /**
   * Whether the property must be positive numeric or parse as a positive
   * numeric and should be removed when set to a falsey value.
   * @type {Object}
   */
  hasPositiveNumericValue: {},

  /**
   * Whether the property can be used as a flag as well as with a value. Removed
   * when strictly equal to false; present without a value when strictly equal
   * to true; present with a value otherwise.
   * @type {Object}
   */
  hasOverloadedBooleanValue: {},

  /**
   * All of the isCustomAttribute() functions that have been injected.
   */
  _isCustomAttributeFunctions: [],

  /**
   * Checks whether a property name is a custom attribute.
   * @method
   */
  isCustomAttribute: function(attributeName) {
    for (var i = 0; i < DOMProperty._isCustomAttributeFunctions.length; i++) {
      var isCustomAttributeFn = DOMProperty._isCustomAttributeFunctions[i];
      if (isCustomAttributeFn(attributeName)) {
        return true;
      }
    }
    return false;
  },

  /**
   * Returns the default property value for a DOM property (i.e., not an
   * attribute). Most default values are '' or false, but not all. Worse yet,
   * some (in particular, `type`) vary depending on the type of element.
   *
   * TODO: Is it better to grab all the possible properties when creating an
   * element to avoid having to create the same element twice?
   */
  getDefaultValueForProperty: function(nodeName, prop) {
    var nodeDefaults = defaultValueCache[nodeName];
    var testElement;
    if (!nodeDefaults) {
      defaultValueCache[nodeName] = nodeDefaults = {};
    }
    if (!(prop in nodeDefaults)) {
      testElement = document.createElement(nodeName);
      nodeDefaults[prop] = testElement[prop];
    }
    return nodeDefaults[prop];
  },

  injection: DOMPropertyInjection
};

module.exports = DOMProperty;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],11:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DOMPropertyOperations
 * @typechecks static-only
 */

"use strict";

var DOMProperty = require("./DOMProperty");

var escapeTextForBrowser = require("./escapeTextForBrowser");
var memoizeStringOnly = require("./memoizeStringOnly");
var warning = require("./warning");

function shouldIgnoreValue(name, value) {
  return value == null ||
    (DOMProperty.hasBooleanValue[name] && !value) ||
    (DOMProperty.hasNumericValue[name] && isNaN(value)) ||
    (DOMProperty.hasPositiveNumericValue[name] && (value < 1)) ||
    (DOMProperty.hasOverloadedBooleanValue[name] && value === false);
}

var processAttributeNameAndPrefix = memoizeStringOnly(function(name) {
  return escapeTextForBrowser(name) + '="';
});

if ("production" !== process.env.NODE_ENV) {
  var reactProps = {
    children: true,
    dangerouslySetInnerHTML: true,
    key: true,
    ref: true
  };
  var warnedProperties = {};

  var warnUnknownProperty = function(name) {
    if (reactProps.hasOwnProperty(name) && reactProps[name] ||
        warnedProperties.hasOwnProperty(name) && warnedProperties[name]) {
      return;
    }

    warnedProperties[name] = true;
    var lowerCasedName = name.toLowerCase();

    // data-* attributes should be lowercase; suggest the lowercase version
    var standardName = (
      DOMProperty.isCustomAttribute(lowerCasedName) ?
        lowerCasedName :
      DOMProperty.getPossibleStandardName.hasOwnProperty(lowerCasedName) ?
        DOMProperty.getPossibleStandardName[lowerCasedName] :
        null
    );

    // For now, only warn when we have a suggested correction. This prevents
    // logging too much when using transferPropsTo.
    ("production" !== process.env.NODE_ENV ? warning(
      standardName == null,
      'Unknown DOM property ' + name + '. Did you mean ' + standardName + '?'
    ) : null);

  };
}

/**
 * Operations for dealing with DOM properties.
 */
var DOMPropertyOperations = {

  /**
   * Creates markup for the ID property.
   *
   * @param {string} id Unescaped ID.
   * @return {string} Markup string.
   */
  createMarkupForID: function(id) {
    return processAttributeNameAndPrefix(DOMProperty.ID_ATTRIBUTE_NAME) +
      escapeTextForBrowser(id) + '"';
  },

  /**
   * Creates markup for a property.
   *
   * @param {string} name
   * @param {*} value
   * @return {?string} Markup string, or null if the property was invalid.
   */
  createMarkupForProperty: function(name, value) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      if (shouldIgnoreValue(name, value)) {
        return '';
      }
      var attributeName = DOMProperty.getAttributeName[name];
      if (DOMProperty.hasBooleanValue[name] ||
          (DOMProperty.hasOverloadedBooleanValue[name] && value === true)) {
        return escapeTextForBrowser(attributeName);
      }
      return processAttributeNameAndPrefix(attributeName) +
        escapeTextForBrowser(value) + '"';
    } else if (DOMProperty.isCustomAttribute(name)) {
      if (value == null) {
        return '';
      }
      return processAttributeNameAndPrefix(name) +
        escapeTextForBrowser(value) + '"';
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
    return null;
  },

  /**
   * Sets the value for a property on a node.
   *
   * @param {DOMElement} node
   * @param {string} name
   * @param {*} value
   */
  setValueForProperty: function(node, name, value) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      var mutationMethod = DOMProperty.getMutationMethod[name];
      if (mutationMethod) {
        mutationMethod(node, value);
      } else if (shouldIgnoreValue(name, value)) {
        this.deleteValueForProperty(node, name);
      } else if (DOMProperty.mustUseAttribute[name]) {
        // `setAttribute` with objects becomes only `[object]` in IE8/9,
        // ('' + value) makes it output the correct toString()-value.
        node.setAttribute(DOMProperty.getAttributeName[name], '' + value);
      } else {
        var propName = DOMProperty.getPropertyName[name];
        // Must explicitly cast values for HAS_SIDE_EFFECTS-properties to the
        // property type before comparing; only `value` does and is string.
        if (!DOMProperty.hasSideEffects[name] ||
            ('' + node[propName]) !== ('' + value)) {
          // Contrary to `setAttribute`, object properties are properly
          // `toString`ed by IE8/9.
          node[propName] = value;
        }
      }
    } else if (DOMProperty.isCustomAttribute(name)) {
      if (value == null) {
        node.removeAttribute(name);
      } else {
        node.setAttribute(name, '' + value);
      }
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
  },

  /**
   * Deletes the value for a property on a node.
   *
   * @param {DOMElement} node
   * @param {string} name
   */
  deleteValueForProperty: function(node, name) {
    if (DOMProperty.isStandardName.hasOwnProperty(name) &&
        DOMProperty.isStandardName[name]) {
      var mutationMethod = DOMProperty.getMutationMethod[name];
      if (mutationMethod) {
        mutationMethod(node, undefined);
      } else if (DOMProperty.mustUseAttribute[name]) {
        node.removeAttribute(DOMProperty.getAttributeName[name]);
      } else {
        var propName = DOMProperty.getPropertyName[name];
        var defaultValue = DOMProperty.getDefaultValueForProperty(
          node.nodeName,
          propName
        );
        if (!DOMProperty.hasSideEffects[name] ||
            ('' + node[propName]) !== defaultValue) {
          node[propName] = defaultValue;
        }
      }
    } else if (DOMProperty.isCustomAttribute(name)) {
      node.removeAttribute(name);
    } else if ("production" !== process.env.NODE_ENV) {
      warnUnknownProperty(name);
    }
  }

};

module.exports = DOMPropertyOperations;

}).call(this,require("ngpmcQ"))
},{"./DOMProperty":10,"./escapeTextForBrowser":109,"./memoizeStringOnly":135,"./warning":145,"ngpmcQ":176}],12:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Danger
 * @typechecks static-only
 */

/*jslint evil: true, sub: true */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var createNodesFromMarkup = require("./createNodesFromMarkup");
var emptyFunction = require("./emptyFunction");
var getMarkupWrap = require("./getMarkupWrap");
var invariant = require("./invariant");

var OPEN_TAG_NAME_EXP = /^(<[^ \/>]+)/;
var RESULT_INDEX_ATTR = 'data-danger-index';

/**
 * Extracts the `nodeName` from a string of markup.
 *
 * NOTE: Extracting the `nodeName` does not require a regular expression match
 * because we make assumptions about React-generated markup (i.e. there are no
 * spaces surrounding the opening tag and there is at least one attribute).
 *
 * @param {string} markup String of markup.
 * @return {string} Node name of the supplied markup.
 * @see http://jsperf.com/extract-nodename
 */
function getNodeName(markup) {
  return markup.substring(1, markup.indexOf(' '));
}

var Danger = {

  /**
   * Renders markup into an array of nodes. The markup is expected to render
   * into a list of root nodes. Also, the length of `resultList` and
   * `markupList` should be the same.
   *
   * @param {array<string>} markupList List of markup strings to render.
   * @return {array<DOMElement>} List of rendered nodes.
   * @internal
   */
  dangerouslyRenderMarkup: function(markupList) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ExecutionEnvironment.canUseDOM,
      'dangerouslyRenderMarkup(...): Cannot render markup in a worker ' +
      'thread. Make sure `window` and `document` are available globally ' +
      'before requiring React when unit testing or use ' +
      'React.renderToString for server rendering.'
    ) : invariant(ExecutionEnvironment.canUseDOM));
    var nodeName;
    var markupByNodeName = {};
    // Group markup by `nodeName` if a wrap is necessary, else by '*'.
    for (var i = 0; i < markupList.length; i++) {
      ("production" !== process.env.NODE_ENV ? invariant(
        markupList[i],
        'dangerouslyRenderMarkup(...): Missing markup.'
      ) : invariant(markupList[i]));
      nodeName = getNodeName(markupList[i]);
      nodeName = getMarkupWrap(nodeName) ? nodeName : '*';
      markupByNodeName[nodeName] = markupByNodeName[nodeName] || [];
      markupByNodeName[nodeName][i] = markupList[i];
    }
    var resultList = [];
    var resultListAssignmentCount = 0;
    for (nodeName in markupByNodeName) {
      if (!markupByNodeName.hasOwnProperty(nodeName)) {
        continue;
      }
      var markupListByNodeName = markupByNodeName[nodeName];

      // This for-in loop skips the holes of the sparse array. The order of
      // iteration should follow the order of assignment, which happens to match
      // numerical index order, but we don't rely on that.
      for (var resultIndex in markupListByNodeName) {
        if (markupListByNodeName.hasOwnProperty(resultIndex)) {
          var markup = markupListByNodeName[resultIndex];

          // Push the requested markup with an additional RESULT_INDEX_ATTR
          // attribute.  If the markup does not start with a < character, it
          // will be discarded below (with an appropriate console.error).
          markupListByNodeName[resultIndex] = markup.replace(
            OPEN_TAG_NAME_EXP,
            // This index will be parsed back out below.
            '$1 ' + RESULT_INDEX_ATTR + '="' + resultIndex + '" '
          );
        }
      }

      // Render each group of markup with similar wrapping `nodeName`.
      var renderNodes = createNodesFromMarkup(
        markupListByNodeName.join(''),
        emptyFunction // Do nothing special with <script> tags.
      );

      for (i = 0; i < renderNodes.length; ++i) {
        var renderNode = renderNodes[i];
        if (renderNode.hasAttribute &&
            renderNode.hasAttribute(RESULT_INDEX_ATTR)) {

          resultIndex = +renderNode.getAttribute(RESULT_INDEX_ATTR);
          renderNode.removeAttribute(RESULT_INDEX_ATTR);

          ("production" !== process.env.NODE_ENV ? invariant(
            !resultList.hasOwnProperty(resultIndex),
            'Danger: Assigning to an already-occupied result index.'
          ) : invariant(!resultList.hasOwnProperty(resultIndex)));

          resultList[resultIndex] = renderNode;

          // This should match resultList.length and markupList.length when
          // we're done.
          resultListAssignmentCount += 1;

        } else if ("production" !== process.env.NODE_ENV) {
          console.error(
            "Danger: Discarding unexpected node:",
            renderNode
          );
        }
      }
    }

    // Although resultList was populated out of order, it should now be a dense
    // array.
    ("production" !== process.env.NODE_ENV ? invariant(
      resultListAssignmentCount === resultList.length,
      'Danger: Did not assign to every index of resultList.'
    ) : invariant(resultListAssignmentCount === resultList.length));

    ("production" !== process.env.NODE_ENV ? invariant(
      resultList.length === markupList.length,
      'Danger: Expected markup to render %s nodes, but rendered %s.',
      markupList.length,
      resultList.length
    ) : invariant(resultList.length === markupList.length));

    return resultList;
  },

  /**
   * Replaces a node with a string of markup at its current position within its
   * parent. The markup must render into a single root node.
   *
   * @param {DOMElement} oldChild Child node to replace.
   * @param {string} markup Markup to render in place of the child node.
   * @internal
   */
  dangerouslyReplaceNodeWithMarkup: function(oldChild, markup) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ExecutionEnvironment.canUseDOM,
      'dangerouslyReplaceNodeWithMarkup(...): Cannot render markup in a ' +
      'worker thread. Make sure `window` and `document` are available ' +
      'globally before requiring React when unit testing or use ' +
      'React.renderToString for server rendering.'
    ) : invariant(ExecutionEnvironment.canUseDOM));
    ("production" !== process.env.NODE_ENV ? invariant(markup, 'dangerouslyReplaceNodeWithMarkup(...): Missing markup.') : invariant(markup));
    ("production" !== process.env.NODE_ENV ? invariant(
      oldChild.tagName.toLowerCase() !== 'html',
      'dangerouslyReplaceNodeWithMarkup(...): Cannot replace markup of the ' +
      '<html> node. This is because browser quirks make this unreliable ' +
      'and/or slow. If you want to render to the root you must use ' +
      'server rendering. See renderComponentToString().'
    ) : invariant(oldChild.tagName.toLowerCase() !== 'html'));

    var newChild = createNodesFromMarkup(markup, emptyFunction)[0];
    oldChild.parentNode.replaceChild(newChild, oldChild);
  }

};

module.exports = Danger;

}).call(this,require("ngpmcQ"))
},{"./ExecutionEnvironment":21,"./createNodesFromMarkup":104,"./emptyFunction":107,"./getMarkupWrap":118,"./invariant":126,"ngpmcQ":176}],13:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule DefaultEventPluginOrder
 */

"use strict";

 var keyOf = require("./keyOf");

/**
 * Module that is injectable into `EventPluginHub`, that specifies a
 * deterministic ordering of `EventPlugin`s. A convenient way to reason about
 * plugins, without having to package every one of them. This is better than
 * having plugins be ordered in the same order that they are injected because
 * that ordering would be influenced by the packaging order.
 * `ResponderEventPlugin` must occur before `SimpleEventPlugin` so that
 * preventing default on events is convenient in `SimpleEventPlugin` handlers.
 */
var DefaultEventPluginOrder = [
  keyOf({ResponderEventPlugin: null}),
  keyOf({SimpleEventPlugin: null}),
  keyOf({TapEventPlugin: null}),
  keyOf({EnterLeaveEventPlugin: null}),
  keyOf({ChangeEventPlugin: null}),
  keyOf({SelectEventPlugin: null}),
  keyOf({CompositionEventPlugin: null}),
  keyOf({BeforeInputEventPlugin: null}),
  keyOf({AnalyticsEventPlugin: null}),
  keyOf({MobileSafariClickEventPlugin: null})
];

module.exports = DefaultEventPluginOrder;

},{"./keyOf":133}],14:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EnterLeaveEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var SyntheticMouseEvent = require("./SyntheticMouseEvent");

var ReactMount = require("./ReactMount");
var keyOf = require("./keyOf");

var topLevelTypes = EventConstants.topLevelTypes;
var getFirstReactDOM = ReactMount.getFirstReactDOM;

var eventTypes = {
  mouseEnter: {
    registrationName: keyOf({onMouseEnter: null}),
    dependencies: [
      topLevelTypes.topMouseOut,
      topLevelTypes.topMouseOver
    ]
  },
  mouseLeave: {
    registrationName: keyOf({onMouseLeave: null}),
    dependencies: [
      topLevelTypes.topMouseOut,
      topLevelTypes.topMouseOver
    ]
  }
};

var extractedEvents = [null, null];

var EnterLeaveEventPlugin = {

  eventTypes: eventTypes,

  /**
   * For almost every interaction we care about, there will be both a top-level
   * `mouseover` and `mouseout` event that occurs. Only use `mouseout` so that
   * we do not extract duplicate events. However, moving the mouse into the
   * browser from outside will not fire a `mouseout` event. In this case, we use
   * the `mouseover` top-level event.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    if (topLevelType === topLevelTypes.topMouseOver &&
        (nativeEvent.relatedTarget || nativeEvent.fromElement)) {
      return null;
    }
    if (topLevelType !== topLevelTypes.topMouseOut &&
        topLevelType !== topLevelTypes.topMouseOver) {
      // Must not be a mouse in or mouse out - ignoring.
      return null;
    }

    var win;
    if (topLevelTarget.window === topLevelTarget) {
      // `topLevelTarget` is probably a window object.
      win = topLevelTarget;
    } else {
      // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
      var doc = topLevelTarget.ownerDocument;
      if (doc) {
        win = doc.defaultView || doc.parentWindow;
      } else {
        win = window;
      }
    }

    var from, to;
    if (topLevelType === topLevelTypes.topMouseOut) {
      from = topLevelTarget;
      to =
        getFirstReactDOM(nativeEvent.relatedTarget || nativeEvent.toElement) ||
        win;
    } else {
      from = win;
      to = topLevelTarget;
    }

    if (from === to) {
      // Nothing pertains to our managed components.
      return null;
    }

    var fromID = from ? ReactMount.getID(from) : '';
    var toID = to ? ReactMount.getID(to) : '';

    var leave = SyntheticMouseEvent.getPooled(
      eventTypes.mouseLeave,
      fromID,
      nativeEvent
    );
    leave.type = 'mouseleave';
    leave.target = from;
    leave.relatedTarget = to;

    var enter = SyntheticMouseEvent.getPooled(
      eventTypes.mouseEnter,
      toID,
      nativeEvent
    );
    enter.type = 'mouseenter';
    enter.target = to;
    enter.relatedTarget = from;

    EventPropagators.accumulateEnterLeaveDispatches(leave, enter, fromID, toID);

    extractedEvents[0] = leave;
    extractedEvents[1] = enter;

    return extractedEvents;
  }

};

module.exports = EnterLeaveEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ReactMount":63,"./SyntheticMouseEvent":91,"./keyOf":133}],15:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventConstants
 */

"use strict";

var keyMirror = require("./keyMirror");

var PropagationPhases = keyMirror({bubbled: null, captured: null});

/**
 * Types of raw signals from the browser caught at the top level.
 */
var topLevelTypes = keyMirror({
  topBlur: null,
  topChange: null,
  topClick: null,
  topCompositionEnd: null,
  topCompositionStart: null,
  topCompositionUpdate: null,
  topContextMenu: null,
  topCopy: null,
  topCut: null,
  topDoubleClick: null,
  topDrag: null,
  topDragEnd: null,
  topDragEnter: null,
  topDragExit: null,
  topDragLeave: null,
  topDragOver: null,
  topDragStart: null,
  topDrop: null,
  topError: null,
  topFocus: null,
  topInput: null,
  topKeyDown: null,
  topKeyPress: null,
  topKeyUp: null,
  topLoad: null,
  topMouseDown: null,
  topMouseMove: null,
  topMouseOut: null,
  topMouseOver: null,
  topMouseUp: null,
  topPaste: null,
  topReset: null,
  topScroll: null,
  topSelectionChange: null,
  topSubmit: null,
  topTextInput: null,
  topTouchCancel: null,
  topTouchEnd: null,
  topTouchMove: null,
  topTouchStart: null,
  topWheel: null
});

var EventConstants = {
  topLevelTypes: topLevelTypes,
  PropagationPhases: PropagationPhases
};

module.exports = EventConstants;

},{"./keyMirror":132}],16:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014 Facebook, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * @providesModule EventListener
 * @typechecks
 */

var emptyFunction = require("./emptyFunction");

/**
 * Upstream version of event listener. Does not take into account specific
 * nature of platform.
 */
var EventListener = {
  /**
   * Listen to DOM events during the bubble phase.
   *
   * @param {DOMEventTarget} target DOM element to register listener on.
   * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
   * @param {function} callback Callback function.
   * @return {object} Object with a `remove` method.
   */
  listen: function(target, eventType, callback) {
    if (target.addEventListener) {
      target.addEventListener(eventType, callback, false);
      return {
        remove: function() {
          target.removeEventListener(eventType, callback, false);
        }
      };
    } else if (target.attachEvent) {
      target.attachEvent('on' + eventType, callback);
      return {
        remove: function() {
          target.detachEvent('on' + eventType, callback);
        }
      };
    }
  },

  /**
   * Listen to DOM events during the capture phase.
   *
   * @param {DOMEventTarget} target DOM element to register listener on.
   * @param {string} eventType Event type, e.g. 'click' or 'mouseover'.
   * @param {function} callback Callback function.
   * @return {object} Object with a `remove` method.
   */
  capture: function(target, eventType, callback) {
    if (!target.addEventListener) {
      if ("production" !== process.env.NODE_ENV) {
        console.error(
          'Attempted to listen to events during the capture phase on a ' +
          'browser that does not support the capture phase. Your application ' +
          'will not receive some events.'
        );
      }
      return {
        remove: emptyFunction
      };
    } else {
      target.addEventListener(eventType, callback, true);
      return {
        remove: function() {
          target.removeEventListener(eventType, callback, true);
        }
      };
    }
  },

  registerDefault: function() {}
};

module.exports = EventListener;

}).call(this,require("ngpmcQ"))
},{"./emptyFunction":107,"ngpmcQ":176}],17:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginHub
 */

"use strict";

var EventPluginRegistry = require("./EventPluginRegistry");
var EventPluginUtils = require("./EventPluginUtils");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");
var invariant = require("./invariant");

/**
 * Internal store for event listeners
 */
var listenerBank = {};

/**
 * Internal queue of events that have accumulated their dispatches and are
 * waiting to have their dispatches executed.
 */
var eventQueue = null;

/**
 * Dispatches an event and releases it back into the pool, unless persistent.
 *
 * @param {?object} event Synthetic event to be dispatched.
 * @private
 */
var executeDispatchesAndRelease = function(event) {
  if (event) {
    var executeDispatch = EventPluginUtils.executeDispatch;
    // Plugins can provide custom behavior when dispatching events.
    var PluginModule = EventPluginRegistry.getPluginModuleForEvent(event);
    if (PluginModule && PluginModule.executeDispatch) {
      executeDispatch = PluginModule.executeDispatch;
    }
    EventPluginUtils.executeDispatchesInOrder(event, executeDispatch);

    if (!event.isPersistent()) {
      event.constructor.release(event);
    }
  }
};

/**
 * - `InstanceHandle`: [required] Module that performs logical traversals of DOM
 *   hierarchy given ids of the logical DOM elements involved.
 */
var InstanceHandle = null;

function validateInstanceHandle() {
  var invalid = !InstanceHandle||
    !InstanceHandle.traverseTwoPhase ||
    !InstanceHandle.traverseEnterLeave;
  if (invalid) {
    throw new Error('InstanceHandle not injected before use!');
  }
}

/**
 * This is a unified interface for event plugins to be installed and configured.
 *
 * Event plugins can implement the following properties:
 *
 *   `extractEvents` {function(string, DOMEventTarget, string, object): *}
 *     Required. When a top-level event is fired, this method is expected to
 *     extract synthetic events that will in turn be queued and dispatched.
 *
 *   `eventTypes` {object}
 *     Optional, plugins that fire events must publish a mapping of registration
 *     names that are used to register listeners. Values of this mapping must
 *     be objects that contain `registrationName` or `phasedRegistrationNames`.
 *
 *   `executeDispatch` {function(object, function, string)}
 *     Optional, allows plugins to override how an event gets dispatched. By
 *     default, the listener is simply invoked.
 *
 * Each plugin that is injected into `EventsPluginHub` is immediately operable.
 *
 * @public
 */
var EventPluginHub = {

  /**
   * Methods for injecting dependencies.
   */
  injection: {

    /**
     * @param {object} InjectedMount
     * @public
     */
    injectMount: EventPluginUtils.injection.injectMount,

    /**
     * @param {object} InjectedInstanceHandle
     * @public
     */
    injectInstanceHandle: function(InjectedInstanceHandle) {
      InstanceHandle = InjectedInstanceHandle;
      if ("production" !== process.env.NODE_ENV) {
        validateInstanceHandle();
      }
    },

    getInstanceHandle: function() {
      if ("production" !== process.env.NODE_ENV) {
        validateInstanceHandle();
      }
      return InstanceHandle;
    },

    /**
     * @param {array} InjectedEventPluginOrder
     * @public
     */
    injectEventPluginOrder: EventPluginRegistry.injectEventPluginOrder,

    /**
     * @param {object} injectedNamesToPlugins Map from names to plugin modules.
     */
    injectEventPluginsByName: EventPluginRegistry.injectEventPluginsByName

  },

  eventNameDispatchConfigs: EventPluginRegistry.eventNameDispatchConfigs,

  registrationNameModules: EventPluginRegistry.registrationNameModules,

  /**
   * Stores `listener` at `listenerBank[registrationName][id]`. Is idempotent.
   *
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @param {?function} listener The callback to store.
   */
  putListener: function(id, registrationName, listener) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !listener || typeof listener === 'function',
      'Expected %s listener to be a function, instead got type %s',
      registrationName, typeof listener
    ) : invariant(!listener || typeof listener === 'function'));

    var bankForRegistrationName =
      listenerBank[registrationName] || (listenerBank[registrationName] = {});
    bankForRegistrationName[id] = listener;
  },

  /**
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @return {?function} The stored callback.
   */
  getListener: function(id, registrationName) {
    var bankForRegistrationName = listenerBank[registrationName];
    return bankForRegistrationName && bankForRegistrationName[id];
  },

  /**
   * Deletes a listener from the registration bank.
   *
   * @param {string} id ID of the DOM element.
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   */
  deleteListener: function(id, registrationName) {
    var bankForRegistrationName = listenerBank[registrationName];
    if (bankForRegistrationName) {
      delete bankForRegistrationName[id];
    }
  },

  /**
   * Deletes all listeners for the DOM element with the supplied ID.
   *
   * @param {string} id ID of the DOM element.
   */
  deleteAllListeners: function(id) {
    for (var registrationName in listenerBank) {
      delete listenerBank[registrationName][id];
    }
  },

  /**
   * Allows registered plugins an opportunity to extract events from top-level
   * native browser events.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @internal
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var events;
    var plugins = EventPluginRegistry.plugins;
    for (var i = 0, l = plugins.length; i < l; i++) {
      // Not every plugin in the ordering may be loaded at runtime.
      var possiblePlugin = plugins[i];
      if (possiblePlugin) {
        var extractedEvents = possiblePlugin.extractEvents(
          topLevelType,
          topLevelTarget,
          topLevelTargetID,
          nativeEvent
        );
        if (extractedEvents) {
          events = accumulateInto(events, extractedEvents);
        }
      }
    }
    return events;
  },

  /**
   * Enqueues a synthetic event that should be dispatched when
   * `processEventQueue` is invoked.
   *
   * @param {*} events An accumulation of synthetic events.
   * @internal
   */
  enqueueEvents: function(events) {
    if (events) {
      eventQueue = accumulateInto(eventQueue, events);
    }
  },

  /**
   * Dispatches all synthetic events on the event queue.
   *
   * @internal
   */
  processEventQueue: function() {
    // Set `eventQueue` to null before processing it so that we can tell if more
    // events get enqueued while processing.
    var processingEventQueue = eventQueue;
    eventQueue = null;
    forEachAccumulated(processingEventQueue, executeDispatchesAndRelease);
    ("production" !== process.env.NODE_ENV ? invariant(
      !eventQueue,
      'processEventQueue(): Additional events were enqueued while processing ' +
      'an event queue. Support for this has not yet been implemented.'
    ) : invariant(!eventQueue));
  },

  /**
   * These are needed for tests only. Do not use!
   */
  __purge: function() {
    listenerBank = {};
  },

  __getListenerBank: function() {
    return listenerBank;
  }

};

module.exports = EventPluginHub;

}).call(this,require("ngpmcQ"))
},{"./EventPluginRegistry":18,"./EventPluginUtils":19,"./accumulateInto":97,"./forEachAccumulated":112,"./invariant":126,"ngpmcQ":176}],18:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginRegistry
 * @typechecks static-only
 */

"use strict";

var invariant = require("./invariant");

/**
 * Injectable ordering of event plugins.
 */
var EventPluginOrder = null;

/**
 * Injectable mapping from names to event plugin modules.
 */
var namesToPlugins = {};

/**
 * Recomputes the plugin list using the injected plugins and plugin ordering.
 *
 * @private
 */
function recomputePluginOrdering() {
  if (!EventPluginOrder) {
    // Wait until an `EventPluginOrder` is injected.
    return;
  }
  for (var pluginName in namesToPlugins) {
    var PluginModule = namesToPlugins[pluginName];
    var pluginIndex = EventPluginOrder.indexOf(pluginName);
    ("production" !== process.env.NODE_ENV ? invariant(
      pluginIndex > -1,
      'EventPluginRegistry: Cannot inject event plugins that do not exist in ' +
      'the plugin ordering, `%s`.',
      pluginName
    ) : invariant(pluginIndex > -1));
    if (EventPluginRegistry.plugins[pluginIndex]) {
      continue;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      PluginModule.extractEvents,
      'EventPluginRegistry: Event plugins must implement an `extractEvents` ' +
      'method, but `%s` does not.',
      pluginName
    ) : invariant(PluginModule.extractEvents));
    EventPluginRegistry.plugins[pluginIndex] = PluginModule;
    var publishedEvents = PluginModule.eventTypes;
    for (var eventName in publishedEvents) {
      ("production" !== process.env.NODE_ENV ? invariant(
        publishEventForPlugin(
          publishedEvents[eventName],
          PluginModule,
          eventName
        ),
        'EventPluginRegistry: Failed to publish event `%s` for plugin `%s`.',
        eventName,
        pluginName
      ) : invariant(publishEventForPlugin(
        publishedEvents[eventName],
        PluginModule,
        eventName
      )));
    }
  }
}

/**
 * Publishes an event so that it can be dispatched by the supplied plugin.
 *
 * @param {object} dispatchConfig Dispatch configuration for the event.
 * @param {object} PluginModule Plugin publishing the event.
 * @return {boolean} True if the event was successfully published.
 * @private
 */
function publishEventForPlugin(dispatchConfig, PluginModule, eventName) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName),
    'EventPluginHub: More than one plugin attempted to publish the same ' +
    'event name, `%s`.',
    eventName
  ) : invariant(!EventPluginRegistry.eventNameDispatchConfigs.hasOwnProperty(eventName)));
  EventPluginRegistry.eventNameDispatchConfigs[eventName] = dispatchConfig;

  var phasedRegistrationNames = dispatchConfig.phasedRegistrationNames;
  if (phasedRegistrationNames) {
    for (var phaseName in phasedRegistrationNames) {
      if (phasedRegistrationNames.hasOwnProperty(phaseName)) {
        var phasedRegistrationName = phasedRegistrationNames[phaseName];
        publishRegistrationName(
          phasedRegistrationName,
          PluginModule,
          eventName
        );
      }
    }
    return true;
  } else if (dispatchConfig.registrationName) {
    publishRegistrationName(
      dispatchConfig.registrationName,
      PluginModule,
      eventName
    );
    return true;
  }
  return false;
}

/**
 * Publishes a registration name that is used to identify dispatched events and
 * can be used with `EventPluginHub.putListener` to register listeners.
 *
 * @param {string} registrationName Registration name to add.
 * @param {object} PluginModule Plugin publishing the event.
 * @private
 */
function publishRegistrationName(registrationName, PluginModule, eventName) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !EventPluginRegistry.registrationNameModules[registrationName],
    'EventPluginHub: More than one plugin attempted to publish the same ' +
    'registration name, `%s`.',
    registrationName
  ) : invariant(!EventPluginRegistry.registrationNameModules[registrationName]));
  EventPluginRegistry.registrationNameModules[registrationName] = PluginModule;
  EventPluginRegistry.registrationNameDependencies[registrationName] =
    PluginModule.eventTypes[eventName].dependencies;
}

/**
 * Registers plugins so that they can extract and dispatch events.
 *
 * @see {EventPluginHub}
 */
var EventPluginRegistry = {

  /**
   * Ordered list of injected plugins.
   */
  plugins: [],

  /**
   * Mapping from event name to dispatch config
   */
  eventNameDispatchConfigs: {},

  /**
   * Mapping from registration name to plugin module
   */
  registrationNameModules: {},

  /**
   * Mapping from registration name to event name
   */
  registrationNameDependencies: {},

  /**
   * Injects an ordering of plugins (by plugin name). This allows the ordering
   * to be decoupled from injection of the actual plugins so that ordering is
   * always deterministic regardless of packaging, on-the-fly injection, etc.
   *
   * @param {array} InjectedEventPluginOrder
   * @internal
   * @see {EventPluginHub.injection.injectEventPluginOrder}
   */
  injectEventPluginOrder: function(InjectedEventPluginOrder) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !EventPluginOrder,
      'EventPluginRegistry: Cannot inject event plugin ordering more than ' +
      'once. You are likely trying to load more than one copy of React.'
    ) : invariant(!EventPluginOrder));
    // Clone the ordering so it cannot be dynamically mutated.
    EventPluginOrder = Array.prototype.slice.call(InjectedEventPluginOrder);
    recomputePluginOrdering();
  },

  /**
   * Injects plugins to be used by `EventPluginHub`. The plugin names must be
   * in the ordering injected by `injectEventPluginOrder`.
   *
   * Plugins can be injected as part of page initialization or on-the-fly.
   *
   * @param {object} injectedNamesToPlugins Map from names to plugin modules.
   * @internal
   * @see {EventPluginHub.injection.injectEventPluginsByName}
   */
  injectEventPluginsByName: function(injectedNamesToPlugins) {
    var isOrderingDirty = false;
    for (var pluginName in injectedNamesToPlugins) {
      if (!injectedNamesToPlugins.hasOwnProperty(pluginName)) {
        continue;
      }
      var PluginModule = injectedNamesToPlugins[pluginName];
      if (!namesToPlugins.hasOwnProperty(pluginName) ||
          namesToPlugins[pluginName] !== PluginModule) {
        ("production" !== process.env.NODE_ENV ? invariant(
          !namesToPlugins[pluginName],
          'EventPluginRegistry: Cannot inject two different event plugins ' +
          'using the same name, `%s`.',
          pluginName
        ) : invariant(!namesToPlugins[pluginName]));
        namesToPlugins[pluginName] = PluginModule;
        isOrderingDirty = true;
      }
    }
    if (isOrderingDirty) {
      recomputePluginOrdering();
    }
  },

  /**
   * Looks up the plugin for the supplied event.
   *
   * @param {object} event A synthetic event.
   * @return {?object} The plugin that created the supplied event.
   * @internal
   */
  getPluginModuleForEvent: function(event) {
    var dispatchConfig = event.dispatchConfig;
    if (dispatchConfig.registrationName) {
      return EventPluginRegistry.registrationNameModules[
        dispatchConfig.registrationName
      ] || null;
    }
    for (var phase in dispatchConfig.phasedRegistrationNames) {
      if (!dispatchConfig.phasedRegistrationNames.hasOwnProperty(phase)) {
        continue;
      }
      var PluginModule = EventPluginRegistry.registrationNameModules[
        dispatchConfig.phasedRegistrationNames[phase]
      ];
      if (PluginModule) {
        return PluginModule;
      }
    }
    return null;
  },

  /**
   * Exposed for unit testing.
   * @private
   */
  _resetEventPlugins: function() {
    EventPluginOrder = null;
    for (var pluginName in namesToPlugins) {
      if (namesToPlugins.hasOwnProperty(pluginName)) {
        delete namesToPlugins[pluginName];
      }
    }
    EventPluginRegistry.plugins.length = 0;

    var eventNameDispatchConfigs = EventPluginRegistry.eventNameDispatchConfigs;
    for (var eventName in eventNameDispatchConfigs) {
      if (eventNameDispatchConfigs.hasOwnProperty(eventName)) {
        delete eventNameDispatchConfigs[eventName];
      }
    }

    var registrationNameModules = EventPluginRegistry.registrationNameModules;
    for (var registrationName in registrationNameModules) {
      if (registrationNameModules.hasOwnProperty(registrationName)) {
        delete registrationNameModules[registrationName];
      }
    }
  }

};

module.exports = EventPluginRegistry;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],19:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPluginUtils
 */

"use strict";

var EventConstants = require("./EventConstants");

var invariant = require("./invariant");

/**
 * Injected dependencies:
 */

/**
 * - `Mount`: [required] Module that can convert between React dom IDs and
 *   actual node references.
 */
var injection = {
  Mount: null,
  injectMount: function(InjectedMount) {
    injection.Mount = InjectedMount;
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? invariant(
        InjectedMount && InjectedMount.getNode,
        'EventPluginUtils.injection.injectMount(...): Injected Mount module ' +
        'is missing getNode.'
      ) : invariant(InjectedMount && InjectedMount.getNode));
    }
  }
};

var topLevelTypes = EventConstants.topLevelTypes;

function isEndish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseUp ||
         topLevelType === topLevelTypes.topTouchEnd ||
         topLevelType === topLevelTypes.topTouchCancel;
}

function isMoveish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseMove ||
         topLevelType === topLevelTypes.topTouchMove;
}
function isStartish(topLevelType) {
  return topLevelType === topLevelTypes.topMouseDown ||
         topLevelType === topLevelTypes.topTouchStart;
}


var validateEventDispatches;
if ("production" !== process.env.NODE_ENV) {
  validateEventDispatches = function(event) {
    var dispatchListeners = event._dispatchListeners;
    var dispatchIDs = event._dispatchIDs;

    var listenersIsArr = Array.isArray(dispatchListeners);
    var idsIsArr = Array.isArray(dispatchIDs);
    var IDsLen = idsIsArr ? dispatchIDs.length : dispatchIDs ? 1 : 0;
    var listenersLen = listenersIsArr ?
      dispatchListeners.length :
      dispatchListeners ? 1 : 0;

    ("production" !== process.env.NODE_ENV ? invariant(
      idsIsArr === listenersIsArr && IDsLen === listenersLen,
      'EventPluginUtils: Invalid `event`.'
    ) : invariant(idsIsArr === listenersIsArr && IDsLen === listenersLen));
  };
}

/**
 * Invokes `cb(event, listener, id)`. Avoids using call if no scope is
 * provided. The `(listener,id)` pair effectively forms the "dispatch" but are
 * kept separate to conserve memory.
 */
function forEachEventDispatch(event, cb) {
  var dispatchListeners = event._dispatchListeners;
  var dispatchIDs = event._dispatchIDs;
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  if (Array.isArray(dispatchListeners)) {
    for (var i = 0; i < dispatchListeners.length; i++) {
      if (event.isPropagationStopped()) {
        break;
      }
      // Listeners and IDs are two parallel arrays that are always in sync.
      cb(event, dispatchListeners[i], dispatchIDs[i]);
    }
  } else if (dispatchListeners) {
    cb(event, dispatchListeners, dispatchIDs);
  }
}

/**
 * Default implementation of PluginModule.executeDispatch().
 * @param {SyntheticEvent} SyntheticEvent to handle
 * @param {function} Application-level callback
 * @param {string} domID DOM id to pass to the callback.
 */
function executeDispatch(event, listener, domID) {
  event.currentTarget = injection.Mount.getNode(domID);
  var returnValue = listener(event, domID);
  event.currentTarget = null;
  return returnValue;
}

/**
 * Standard/simple iteration through an event's collected dispatches.
 */
function executeDispatchesInOrder(event, executeDispatch) {
  forEachEventDispatch(event, executeDispatch);
  event._dispatchListeners = null;
  event._dispatchIDs = null;
}

/**
 * Standard/simple iteration through an event's collected dispatches, but stops
 * at the first dispatch execution returning true, and returns that id.
 *
 * @return id of the first dispatch execution who's listener returns true, or
 * null if no listener returned true.
 */
function executeDispatchesInOrderStopAtTrueImpl(event) {
  var dispatchListeners = event._dispatchListeners;
  var dispatchIDs = event._dispatchIDs;
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  if (Array.isArray(dispatchListeners)) {
    for (var i = 0; i < dispatchListeners.length; i++) {
      if (event.isPropagationStopped()) {
        break;
      }
      // Listeners and IDs are two parallel arrays that are always in sync.
      if (dispatchListeners[i](event, dispatchIDs[i])) {
        return dispatchIDs[i];
      }
    }
  } else if (dispatchListeners) {
    if (dispatchListeners(event, dispatchIDs)) {
      return dispatchIDs;
    }
  }
  return null;
}

/**
 * @see executeDispatchesInOrderStopAtTrueImpl
 */
function executeDispatchesInOrderStopAtTrue(event) {
  var ret = executeDispatchesInOrderStopAtTrueImpl(event);
  event._dispatchIDs = null;
  event._dispatchListeners = null;
  return ret;
}

/**
 * Execution of a "direct" dispatch - there must be at most one dispatch
 * accumulated on the event or it is considered an error. It doesn't really make
 * sense for an event with multiple dispatches (bubbled) to keep track of the
 * return values at each dispatch execution, but it does tend to make sense when
 * dealing with "direct" dispatches.
 *
 * @return The return value of executing the single dispatch.
 */
function executeDirectDispatch(event) {
  if ("production" !== process.env.NODE_ENV) {
    validateEventDispatches(event);
  }
  var dispatchListener = event._dispatchListeners;
  var dispatchID = event._dispatchIDs;
  ("production" !== process.env.NODE_ENV ? invariant(
    !Array.isArray(dispatchListener),
    'executeDirectDispatch(...): Invalid `event`.'
  ) : invariant(!Array.isArray(dispatchListener)));
  var res = dispatchListener ?
    dispatchListener(event, dispatchID) :
    null;
  event._dispatchListeners = null;
  event._dispatchIDs = null;
  return res;
}

/**
 * @param {SyntheticEvent} event
 * @return {bool} True iff number of dispatches accumulated is greater than 0.
 */
function hasDispatches(event) {
  return !!event._dispatchListeners;
}

/**
 * General utilities that are useful in creating custom Event Plugins.
 */
var EventPluginUtils = {
  isEndish: isEndish,
  isMoveish: isMoveish,
  isStartish: isStartish,

  executeDirectDispatch: executeDirectDispatch,
  executeDispatch: executeDispatch,
  executeDispatchesInOrder: executeDispatchesInOrder,
  executeDispatchesInOrderStopAtTrue: executeDispatchesInOrderStopAtTrue,
  hasDispatches: hasDispatches,
  injection: injection,
  useTouchEvents: false
};

module.exports = EventPluginUtils;

}).call(this,require("ngpmcQ"))
},{"./EventConstants":15,"./invariant":126,"ngpmcQ":176}],20:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule EventPropagators
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");

var PropagationPhases = EventConstants.PropagationPhases;
var getListener = EventPluginHub.getListener;

/**
 * Some event types have a notion of different registration names for different
 * "phases" of propagation. This finds listeners by a given phase.
 */
function listenerAtPhase(id, event, propagationPhase) {
  var registrationName =
    event.dispatchConfig.phasedRegistrationNames[propagationPhase];
  return getListener(id, registrationName);
}

/**
 * Tags a `SyntheticEvent` with dispatched listeners. Creating this function
 * here, allows us to not have to bind or create functions for each event.
 * Mutating the event's members allows us to not have to create a wrapping
 * "dispatch" object that pairs the event with the listener.
 */
function accumulateDirectionalDispatches(domID, upwards, event) {
  if ("production" !== process.env.NODE_ENV) {
    if (!domID) {
      throw new Error('Dispatching id must not be null');
    }
  }
  var phase = upwards ? PropagationPhases.bubbled : PropagationPhases.captured;
  var listener = listenerAtPhase(domID, event, phase);
  if (listener) {
    event._dispatchListeners =
      accumulateInto(event._dispatchListeners, listener);
    event._dispatchIDs = accumulateInto(event._dispatchIDs, domID);
  }
}

/**
 * Collect dispatches (must be entirely collected before dispatching - see unit
 * tests). Lazily allocate the array to conserve memory.  We must loop through
 * each event and perform the traversal for each one. We can not perform a
 * single traversal for the entire collection of events because each event may
 * have a different target.
 */
function accumulateTwoPhaseDispatchesSingle(event) {
  if (event && event.dispatchConfig.phasedRegistrationNames) {
    EventPluginHub.injection.getInstanceHandle().traverseTwoPhase(
      event.dispatchMarker,
      accumulateDirectionalDispatches,
      event
    );
  }
}


/**
 * Accumulates without regard to direction, does not look for phased
 * registration names. Same as `accumulateDirectDispatchesSingle` but without
 * requiring that the `dispatchMarker` be the same as the dispatched ID.
 */
function accumulateDispatches(id, ignoredDirection, event) {
  if (event && event.dispatchConfig.registrationName) {
    var registrationName = event.dispatchConfig.registrationName;
    var listener = getListener(id, registrationName);
    if (listener) {
      event._dispatchListeners =
        accumulateInto(event._dispatchListeners, listener);
      event._dispatchIDs = accumulateInto(event._dispatchIDs, id);
    }
  }
}

/**
 * Accumulates dispatches on an `SyntheticEvent`, but only for the
 * `dispatchMarker`.
 * @param {SyntheticEvent} event
 */
function accumulateDirectDispatchesSingle(event) {
  if (event && event.dispatchConfig.registrationName) {
    accumulateDispatches(event.dispatchMarker, null, event);
  }
}

function accumulateTwoPhaseDispatches(events) {
  forEachAccumulated(events, accumulateTwoPhaseDispatchesSingle);
}

function accumulateEnterLeaveDispatches(leave, enter, fromID, toID) {
  EventPluginHub.injection.getInstanceHandle().traverseEnterLeave(
    fromID,
    toID,
    accumulateDispatches,
    leave,
    enter
  );
}


function accumulateDirectDispatches(events) {
  forEachAccumulated(events, accumulateDirectDispatchesSingle);
}



/**
 * A small set of propagation patterns, each of which will accept a small amount
 * of information, and generate a set of "dispatch ready event objects" - which
 * are sets of events that have already been annotated with a set of dispatched
 * listener functions/ids. The API is designed this way to discourage these
 * propagation strategies from actually executing the dispatches, since we
 * always want to collect the entire set of dispatches before executing event a
 * single one.
 *
 * @constructor EventPropagators
 */
var EventPropagators = {
  accumulateTwoPhaseDispatches: accumulateTwoPhaseDispatches,
  accumulateDirectDispatches: accumulateDirectDispatches,
  accumulateEnterLeaveDispatches: accumulateEnterLeaveDispatches
};

module.exports = EventPropagators;

}).call(this,require("ngpmcQ"))
},{"./EventConstants":15,"./EventPluginHub":17,"./accumulateInto":97,"./forEachAccumulated":112,"ngpmcQ":176}],21:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ExecutionEnvironment
 */

/*jslint evil: true */

"use strict";

var canUseDOM = !!(
  typeof window !== 'undefined' &&
  window.document &&
  window.document.createElement
);

/**
 * Simple, lightweight module assisting with the detection and context of
 * Worker. Helps avoid circular dependencies and allows code to reason about
 * whether or not they are in a Worker, even if they never include the main
 * `ReactWorker` dependency.
 */
var ExecutionEnvironment = {

  canUseDOM: canUseDOM,

  canUseWorkers: typeof Worker !== 'undefined',

  canUseEventListeners:
    canUseDOM && !!(window.addEventListener || window.attachEvent),

  canUseViewport: canUseDOM && !!window.screen,

  isInWorker: !canUseDOM // For now, this is true - might change in the future.

};

module.exports = ExecutionEnvironment;

},{}],22:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule HTMLDOMPropertyConfig
 */

/*jslint bitwise: true*/

"use strict";

var DOMProperty = require("./DOMProperty");
var ExecutionEnvironment = require("./ExecutionEnvironment");

var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;
var MUST_USE_PROPERTY = DOMProperty.injection.MUST_USE_PROPERTY;
var HAS_BOOLEAN_VALUE = DOMProperty.injection.HAS_BOOLEAN_VALUE;
var HAS_SIDE_EFFECTS = DOMProperty.injection.HAS_SIDE_EFFECTS;
var HAS_NUMERIC_VALUE = DOMProperty.injection.HAS_NUMERIC_VALUE;
var HAS_POSITIVE_NUMERIC_VALUE =
  DOMProperty.injection.HAS_POSITIVE_NUMERIC_VALUE;
var HAS_OVERLOADED_BOOLEAN_VALUE =
  DOMProperty.injection.HAS_OVERLOADED_BOOLEAN_VALUE;

var hasSVG;
if (ExecutionEnvironment.canUseDOM) {
  var implementation = document.implementation;
  hasSVG = (
    implementation &&
    implementation.hasFeature &&
    implementation.hasFeature(
      'http://www.w3.org/TR/SVG11/feature#BasicStructure',
      '1.1'
    )
  );
}


var HTMLDOMPropertyConfig = {
  isCustomAttribute: RegExp.prototype.test.bind(
    /^(data|aria)-[a-z_][a-z\d_.\-]*$/
  ),
  Properties: {
    /**
     * Standard Properties
     */
    accept: null,
    acceptCharset: null,
    accessKey: null,
    action: null,
    allowFullScreen: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    allowTransparency: MUST_USE_ATTRIBUTE,
    alt: null,
    async: HAS_BOOLEAN_VALUE,
    autoComplete: null,
    // autoFocus is polyfilled/normalized by AutoFocusMixin
    // autoFocus: HAS_BOOLEAN_VALUE,
    autoPlay: HAS_BOOLEAN_VALUE,
    cellPadding: null,
    cellSpacing: null,
    charSet: MUST_USE_ATTRIBUTE,
    checked: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    classID: MUST_USE_ATTRIBUTE,
    // To set className on SVG elements, it's necessary to use .setAttribute;
    // this works on HTML elements too in all browsers except IE8. Conveniently,
    // IE8 doesn't support SVG and so we can simply use the attribute in
    // browsers that support SVG and the property in browsers that don't,
    // regardless of whether the element is HTML or SVG.
    className: hasSVG ? MUST_USE_ATTRIBUTE : MUST_USE_PROPERTY,
    cols: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    colSpan: null,
    content: null,
    contentEditable: null,
    contextMenu: MUST_USE_ATTRIBUTE,
    controls: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    coords: null,
    crossOrigin: null,
    data: null, // For `<object />` acts as `src`.
    dateTime: MUST_USE_ATTRIBUTE,
    defer: HAS_BOOLEAN_VALUE,
    dir: null,
    disabled: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    download: HAS_OVERLOADED_BOOLEAN_VALUE,
    draggable: null,
    encType: null,
    form: MUST_USE_ATTRIBUTE,
    formAction: MUST_USE_ATTRIBUTE,
    formEncType: MUST_USE_ATTRIBUTE,
    formMethod: MUST_USE_ATTRIBUTE,
    formNoValidate: HAS_BOOLEAN_VALUE,
    formTarget: MUST_USE_ATTRIBUTE,
    frameBorder: MUST_USE_ATTRIBUTE,
    height: MUST_USE_ATTRIBUTE,
    hidden: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    href: null,
    hrefLang: null,
    htmlFor: null,
    httpEquiv: null,
    icon: null,
    id: MUST_USE_PROPERTY,
    label: null,
    lang: null,
    list: MUST_USE_ATTRIBUTE,
    loop: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    manifest: MUST_USE_ATTRIBUTE,
    marginHeight: null,
    marginWidth: null,
    max: null,
    maxLength: MUST_USE_ATTRIBUTE,
    media: MUST_USE_ATTRIBUTE,
    mediaGroup: null,
    method: null,
    min: null,
    multiple: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    muted: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    name: null,
    noValidate: HAS_BOOLEAN_VALUE,
    open: null,
    pattern: null,
    placeholder: null,
    poster: null,
    preload: null,
    radioGroup: null,
    readOnly: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    rel: null,
    required: HAS_BOOLEAN_VALUE,
    role: MUST_USE_ATTRIBUTE,
    rows: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    rowSpan: null,
    sandbox: null,
    scope: null,
    scrolling: null,
    seamless: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE,
    selected: MUST_USE_PROPERTY | HAS_BOOLEAN_VALUE,
    shape: null,
    size: MUST_USE_ATTRIBUTE | HAS_POSITIVE_NUMERIC_VALUE,
    sizes: MUST_USE_ATTRIBUTE,
    span: HAS_POSITIVE_NUMERIC_VALUE,
    spellCheck: null,
    src: null,
    srcDoc: MUST_USE_PROPERTY,
    srcSet: MUST_USE_ATTRIBUTE,
    start: HAS_NUMERIC_VALUE,
    step: null,
    style: null,
    tabIndex: null,
    target: null,
    title: null,
    type: null,
    useMap: null,
    value: MUST_USE_PROPERTY | HAS_SIDE_EFFECTS,
    width: MUST_USE_ATTRIBUTE,
    wmode: MUST_USE_ATTRIBUTE,

    /**
     * Non-standard Properties
     */
    autoCapitalize: null, // Supported in Mobile Safari for keyboard hints
    autoCorrect: null, // Supported in Mobile Safari for keyboard hints
    itemProp: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
    itemScope: MUST_USE_ATTRIBUTE | HAS_BOOLEAN_VALUE, // Microdata: http://schema.org/docs/gs.html
    itemType: MUST_USE_ATTRIBUTE, // Microdata: http://schema.org/docs/gs.html
    property: null // Supports OG in meta tags
  },
  DOMAttributeNames: {
    acceptCharset: 'accept-charset',
    className: 'class',
    htmlFor: 'for',
    httpEquiv: 'http-equiv'
  },
  DOMPropertyNames: {
    autoCapitalize: 'autocapitalize',
    autoComplete: 'autocomplete',
    autoCorrect: 'autocorrect',
    autoFocus: 'autofocus',
    autoPlay: 'autoplay',
    encType: 'enctype',
    hrefLang: 'hreflang',
    radioGroup: 'radiogroup',
    spellCheck: 'spellcheck',
    srcDoc: 'srcdoc',
    srcSet: 'srcset'
  }
};

module.exports = HTMLDOMPropertyConfig;

},{"./DOMProperty":10,"./ExecutionEnvironment":21}],23:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule LinkedValueUtils
 * @typechecks static-only
 */

"use strict";

var ReactPropTypes = require("./ReactPropTypes");

var invariant = require("./invariant");

var hasReadOnlyValue = {
  'button': true,
  'checkbox': true,
  'image': true,
  'hidden': true,
  'radio': true,
  'reset': true,
  'submit': true
};

function _assertSingleLink(input) {
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.checkedLink == null || input.props.valueLink == null,
    'Cannot provide a checkedLink and a valueLink. If you want to use ' +
    'checkedLink, you probably don\'t want to use valueLink and vice versa.'
  ) : invariant(input.props.checkedLink == null || input.props.valueLink == null));
}
function _assertValueLink(input) {
  _assertSingleLink(input);
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.value == null && input.props.onChange == null,
    'Cannot provide a valueLink and a value or onChange event. If you want ' +
    'to use value or onChange, you probably don\'t want to use valueLink.'
  ) : invariant(input.props.value == null && input.props.onChange == null));
}

function _assertCheckedLink(input) {
  _assertSingleLink(input);
  ("production" !== process.env.NODE_ENV ? invariant(
    input.props.checked == null && input.props.onChange == null,
    'Cannot provide a checkedLink and a checked property or onChange event. ' +
    'If you want to use checked or onChange, you probably don\'t want to ' +
    'use checkedLink'
  ) : invariant(input.props.checked == null && input.props.onChange == null));
}

/**
 * @param {SyntheticEvent} e change event to handle
 */
function _handleLinkedValueChange(e) {
  /*jshint validthis:true */
  this.props.valueLink.requestChange(e.target.value);
}

/**
  * @param {SyntheticEvent} e change event to handle
  */
function _handleLinkedCheckChange(e) {
  /*jshint validthis:true */
  this.props.checkedLink.requestChange(e.target.checked);
}

/**
 * Provide a linked `value` attribute for controlled forms. You should not use
 * this outside of the ReactDOM controlled form components.
 */
var LinkedValueUtils = {
  Mixin: {
    propTypes: {
      value: function(props, propName, componentName) {
        if (!props[propName] ||
            hasReadOnlyValue[props.type] ||
            props.onChange ||
            props.readOnly ||
            props.disabled) {
          return;
        }
        return new Error(
          'You provided a `value` prop to a form field without an ' +
          '`onChange` handler. This will render a read-only field. If ' +
          'the field should be mutable use `defaultValue`. Otherwise, ' +
          'set either `onChange` or `readOnly`.'
        );
      },
      checked: function(props, propName, componentName) {
        if (!props[propName] ||
            props.onChange ||
            props.readOnly ||
            props.disabled) {
          return;
        }
        return new Error(
          'You provided a `checked` prop to a form field without an ' +
          '`onChange` handler. This will render a read-only field. If ' +
          'the field should be mutable use `defaultChecked`. Otherwise, ' +
          'set either `onChange` or `readOnly`.'
        );
      },
      onChange: ReactPropTypes.func
    }
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {*} current value of the input either from value prop or link.
   */
  getValue: function(input) {
    if (input.props.valueLink) {
      _assertValueLink(input);
      return input.props.valueLink.value;
    }
    return input.props.value;
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {*} current checked status of the input either from checked prop
   *             or link.
   */
  getChecked: function(input) {
    if (input.props.checkedLink) {
      _assertCheckedLink(input);
      return input.props.checkedLink.value;
    }
    return input.props.checked;
  },

  /**
   * @param {ReactComponent} input Form component
   * @return {function} change callback either from onChange prop or link.
   */
  getOnChange: function(input) {
    if (input.props.valueLink) {
      _assertValueLink(input);
      return _handleLinkedValueChange;
    } else if (input.props.checkedLink) {
      _assertCheckedLink(input);
      return _handleLinkedCheckChange;
    }
    return input.props.onChange;
  }
};

module.exports = LinkedValueUtils;

}).call(this,require("ngpmcQ"))
},{"./ReactPropTypes":72,"./invariant":126,"ngpmcQ":176}],24:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule LocalEventTrapMixin
 */

"use strict";

var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");

var accumulateInto = require("./accumulateInto");
var forEachAccumulated = require("./forEachAccumulated");
var invariant = require("./invariant");

function remove(event) {
  event.remove();
}

var LocalEventTrapMixin = {
  trapBubbledEvent:function(topLevelType, handlerBaseName) {
    ("production" !== process.env.NODE_ENV ? invariant(this.isMounted(), 'Must be mounted to trap events') : invariant(this.isMounted()));
    var listener = ReactBrowserEventEmitter.trapBubbledEvent(
      topLevelType,
      handlerBaseName,
      this.getDOMNode()
    );
    this._localEventListeners =
      accumulateInto(this._localEventListeners, listener);
  },

  // trapCapturedEvent would look nearly identical. We don't implement that
  // method because it isn't currently needed.

  componentWillUnmount:function() {
    if (this._localEventListeners) {
      forEachAccumulated(this._localEventListeners, remove);
    }
  }
};

module.exports = LocalEventTrapMixin;

}).call(this,require("ngpmcQ"))
},{"./ReactBrowserEventEmitter":30,"./accumulateInto":97,"./forEachAccumulated":112,"./invariant":126,"ngpmcQ":176}],25:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule MobileSafariClickEventPlugin
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");

var emptyFunction = require("./emptyFunction");

var topLevelTypes = EventConstants.topLevelTypes;

/**
 * Mobile Safari does not fire properly bubble click events on non-interactive
 * elements, which means delegated click listeners do not fire. The workaround
 * for this bug involves attaching an empty click listener on the target node.
 *
 * This particular plugin works around the bug by attaching an empty click
 * listener on `touchstart` (which does fire on every element).
 */
var MobileSafariClickEventPlugin = {

  eventTypes: null,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    if (topLevelType === topLevelTypes.topTouchStart) {
      var target = nativeEvent.target;
      if (target && !target.onclick) {
        target.onclick = emptyFunction;
      }
    }
  }

};

module.exports = MobileSafariClickEventPlugin;

},{"./EventConstants":15,"./emptyFunction":107}],26:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Object.assign
 */

// https://people.mozilla.org/~jorendorff/es6-draft.html#sec-object.assign

function assign(target, sources) {
  if (target == null) {
    throw new TypeError('Object.assign target cannot be null or undefined');
  }

  var to = Object(target);
  var hasOwnProperty = Object.prototype.hasOwnProperty;

  for (var nextIndex = 1; nextIndex < arguments.length; nextIndex++) {
    var nextSource = arguments[nextIndex];
    if (nextSource == null) {
      continue;
    }

    var from = Object(nextSource);

    // We don't currently support accessors nor proxies. Therefore this
    // copy cannot throw. If we ever supported this then we must handle
    // exceptions and side-effects. We don't support symbols so they won't
    // be transferred.

    for (var key in from) {
      if (hasOwnProperty.call(from, key)) {
        to[key] = from[key];
      }
    }
  }

  return to;
};

module.exports = assign;

},{}],27:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule PooledClass
 */

"use strict";

var invariant = require("./invariant");

/**
 * Static poolers. Several custom versions for each potential number of
 * arguments. A completely generic pooler is easy to implement, but would
 * require accessing the `arguments` object. In each of these, `this` refers to
 * the Class itself, not an instance. If any others are needed, simply add them
 * here, or in their own files.
 */
var oneArgumentPooler = function(copyFieldsFrom) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, copyFieldsFrom);
    return instance;
  } else {
    return new Klass(copyFieldsFrom);
  }
};

var twoArgumentPooler = function(a1, a2) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2);
    return instance;
  } else {
    return new Klass(a1, a2);
  }
};

var threeArgumentPooler = function(a1, a2, a3) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2, a3);
    return instance;
  } else {
    return new Klass(a1, a2, a3);
  }
};

var fiveArgumentPooler = function(a1, a2, a3, a4, a5) {
  var Klass = this;
  if (Klass.instancePool.length) {
    var instance = Klass.instancePool.pop();
    Klass.call(instance, a1, a2, a3, a4, a5);
    return instance;
  } else {
    return new Klass(a1, a2, a3, a4, a5);
  }
};

var standardReleaser = function(instance) {
  var Klass = this;
  ("production" !== process.env.NODE_ENV ? invariant(
    instance instanceof Klass,
    'Trying to release an instance into a pool of a different type.'
  ) : invariant(instance instanceof Klass));
  if (instance.destructor) {
    instance.destructor();
  }
  if (Klass.instancePool.length < Klass.poolSize) {
    Klass.instancePool.push(instance);
  }
};

var DEFAULT_POOL_SIZE = 10;
var DEFAULT_POOLER = oneArgumentPooler;

/**
 * Augments `CopyConstructor` to be a poolable class, augmenting only the class
 * itself (statically) not adding any prototypical fields. Any CopyConstructor
 * you give this may have a `poolSize` property, and will look for a
 * prototypical `destructor` on instances (optional).
 *
 * @param {Function} CopyConstructor Constructor that can be used to reset.
 * @param {Function} pooler Customizable pooler.
 */
var addPoolingTo = function(CopyConstructor, pooler) {
  var NewKlass = CopyConstructor;
  NewKlass.instancePool = [];
  NewKlass.getPooled = pooler || DEFAULT_POOLER;
  if (!NewKlass.poolSize) {
    NewKlass.poolSize = DEFAULT_POOL_SIZE;
  }
  NewKlass.release = standardReleaser;
  return NewKlass;
};

var PooledClass = {
  addPoolingTo: addPoolingTo,
  oneArgumentPooler: oneArgumentPooler,
  twoArgumentPooler: twoArgumentPooler,
  threeArgumentPooler: threeArgumentPooler,
  fiveArgumentPooler: fiveArgumentPooler
};

module.exports = PooledClass;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],28:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule React
 */

"use strict";

var DOMPropertyOperations = require("./DOMPropertyOperations");
var EventPluginUtils = require("./EventPluginUtils");
var ReactChildren = require("./ReactChildren");
var ReactComponent = require("./ReactComponent");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactDOM = require("./ReactDOM");
var ReactDOMComponent = require("./ReactDOMComponent");
var ReactDefaultInjection = require("./ReactDefaultInjection");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactMount = require("./ReactMount");
var ReactMultiChild = require("./ReactMultiChild");
var ReactPerf = require("./ReactPerf");
var ReactPropTypes = require("./ReactPropTypes");
var ReactServerRendering = require("./ReactServerRendering");
var ReactTextComponent = require("./ReactTextComponent");

var assign = require("./Object.assign");
var deprecated = require("./deprecated");
var onlyChild = require("./onlyChild");

ReactDefaultInjection.inject();

var createElement = ReactElement.createElement;
var createFactory = ReactElement.createFactory;

if ("production" !== process.env.NODE_ENV) {
  createElement = ReactElementValidator.createElement;
  createFactory = ReactElementValidator.createFactory;
}

// TODO: Drop legacy elements once classes no longer export these factories
createElement = ReactLegacyElement.wrapCreateElement(
  createElement
);
createFactory = ReactLegacyElement.wrapCreateFactory(
  createFactory
);

var render = ReactPerf.measure('React', 'render', ReactMount.render);

var React = {
  Children: {
    map: ReactChildren.map,
    forEach: ReactChildren.forEach,
    count: ReactChildren.count,
    only: onlyChild
  },
  DOM: ReactDOM,
  PropTypes: ReactPropTypes,
  initializeTouchEvents: function(shouldUseTouch) {
    EventPluginUtils.useTouchEvents = shouldUseTouch;
  },
  createClass: ReactCompositeComponent.createClass,
  createElement: createElement,
  createFactory: createFactory,
  constructAndRenderComponent: ReactMount.constructAndRenderComponent,
  constructAndRenderComponentByID: ReactMount.constructAndRenderComponentByID,
  render: render,
  renderToString: ReactServerRendering.renderToString,
  renderToStaticMarkup: ReactServerRendering.renderToStaticMarkup,
  unmountComponentAtNode: ReactMount.unmountComponentAtNode,
  isValidClass: ReactLegacyElement.isValidClass,
  isValidElement: ReactElement.isValidElement,
  withContext: ReactContext.withContext,

  // Hook for JSX spread, don't use this for anything else.
  __spread: assign,

  // Deprecations (remove for 0.13)
  renderComponent: deprecated(
    'React',
    'renderComponent',
    'render',
    this,
    render
  ),
  renderComponentToString: deprecated(
    'React',
    'renderComponentToString',
    'renderToString',
    this,
    ReactServerRendering.renderToString
  ),
  renderComponentToStaticMarkup: deprecated(
    'React',
    'renderComponentToStaticMarkup',
    'renderToStaticMarkup',
    this,
    ReactServerRendering.renderToStaticMarkup
  ),
  isValidComponent: deprecated(
    'React',
    'isValidComponent',
    'isValidElement',
    this,
    ReactElement.isValidElement
  )
};

// Inject the runtime into a devtools global hook regardless of browser.
// Allows for debugging when the hook is injected on the page.
if (
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== 'undefined' &&
  typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.inject === 'function') {
  __REACT_DEVTOOLS_GLOBAL_HOOK__.inject({
    Component: ReactComponent,
    CurrentOwner: ReactCurrentOwner,
    DOMComponent: ReactDOMComponent,
    DOMPropertyOperations: DOMPropertyOperations,
    InstanceHandles: ReactInstanceHandles,
    Mount: ReactMount,
    MultiChild: ReactMultiChild,
    TextComponent: ReactTextComponent
  });
}

if ("production" !== process.env.NODE_ENV) {
  var ExecutionEnvironment = require("./ExecutionEnvironment");
  if (ExecutionEnvironment.canUseDOM && window.top === window.self) {

    // If we're in Chrome, look for the devtools marker and provide a download
    // link if not installed.
    if (navigator.userAgent.indexOf('Chrome') > -1) {
      if (typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ === 'undefined') {
        console.debug(
          'Download the React DevTools for a better development experience: ' +
          'http://fb.me/react-devtools'
        );
      }
    }

    var expectedFeatures = [
      // shims
      Array.isArray,
      Array.prototype.every,
      Array.prototype.forEach,
      Array.prototype.indexOf,
      Array.prototype.map,
      Date.now,
      Function.prototype.bind,
      Object.keys,
      String.prototype.split,
      String.prototype.trim,

      // shams
      Object.create,
      Object.freeze
    ];

    for (var i = 0; i < expectedFeatures.length; i++) {
      if (!expectedFeatures[i]) {
        console.error(
          'One or more ES5 shim/shams expected by React are not available: ' +
          'http://fb.me/react-warning-polyfills'
        );
        break;
      }
    }
  }
}

// Version exists only in the open-source version of React, not in Facebook's
// internal version.
React.version = '0.12.2';

module.exports = React;

}).call(this,require("ngpmcQ"))
},{"./DOMPropertyOperations":11,"./EventPluginUtils":19,"./ExecutionEnvironment":21,"./Object.assign":26,"./ReactChildren":31,"./ReactComponent":32,"./ReactCompositeComponent":34,"./ReactContext":35,"./ReactCurrentOwner":36,"./ReactDOM":37,"./ReactDOMComponent":39,"./ReactDefaultInjection":49,"./ReactElement":52,"./ReactElementValidator":53,"./ReactInstanceHandles":60,"./ReactLegacyElement":61,"./ReactMount":63,"./ReactMultiChild":64,"./ReactPerf":68,"./ReactPropTypes":72,"./ReactServerRendering":76,"./ReactTextComponent":78,"./deprecated":106,"./onlyChild":137,"ngpmcQ":176}],29:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactBrowserComponentMixin
 */

"use strict";

var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactMount = require("./ReactMount");

var invariant = require("./invariant");

var ReactBrowserComponentMixin = {
  /**
   * Returns the DOM node rendered by this component.
   *
   * @return {DOMElement} The root node of this component.
   * @final
   * @protected
   */
  getDOMNode: function() {
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isMounted(),
      'getDOMNode(): A component must be mounted to have a DOM node.'
    ) : invariant(this.isMounted()));
    if (ReactEmptyComponent.isNullComponentID(this._rootNodeID)) {
      return null;
    }
    return ReactMount.getNode(this._rootNodeID);
  }
};

module.exports = ReactBrowserComponentMixin;

}).call(this,require("ngpmcQ"))
},{"./ReactEmptyComponent":54,"./ReactMount":63,"./invariant":126,"ngpmcQ":176}],30:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactBrowserEventEmitter
 * @typechecks static-only
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginHub = require("./EventPluginHub");
var EventPluginRegistry = require("./EventPluginRegistry");
var ReactEventEmitterMixin = require("./ReactEventEmitterMixin");
var ViewportMetrics = require("./ViewportMetrics");

var assign = require("./Object.assign");
var isEventSupported = require("./isEventSupported");

/**
 * Summary of `ReactBrowserEventEmitter` event handling:
 *
 *  - Top-level delegation is used to trap most native browser events. This
 *    may only occur in the main thread and is the responsibility of
 *    ReactEventListener, which is injected and can therefore support pluggable
 *    event sources. This is the only work that occurs in the main thread.
 *
 *  - We normalize and de-duplicate events to account for browser quirks. This
 *    may be done in the worker thread.
 *
 *  - Forward these native events (with the associated top-level type used to
 *    trap it) to `EventPluginHub`, which in turn will ask plugins if they want
 *    to extract any synthetic events.
 *
 *  - The `EventPluginHub` will then process each event by annotating them with
 *    "dispatches", a sequence of listeners and IDs that care about that event.
 *
 *  - The `EventPluginHub` then dispatches the events.
 *
 * Overview of React and the event system:
 *
 * +------------+    .
 * |    DOM     |    .
 * +------------+    .
 *       |           .
 *       v           .
 * +------------+    .
 * | ReactEvent |    .
 * |  Listener  |    .
 * +------------+    .                         +-----------+
 *       |           .               +--------+|SimpleEvent|
 *       |           .               |         |Plugin     |
 * +-----|------+    .               v         +-----------+
 * |     |      |    .    +--------------+                    +------------+
 * |     +-----------.--->|EventPluginHub|                    |    Event   |
 * |            |    .    |              |     +-----------+  | Propagators|
 * | ReactEvent |    .    |              |     |TapEvent   |  |------------|
 * |  Emitter   |    .    |              |<---+|Plugin     |  |other plugin|
 * |            |    .    |              |     +-----------+  |  utilities |
 * |     +-----------.--->|              |                    +------------+
 * |     |      |    .    +--------------+
 * +-----|------+    .                ^        +-----------+
 *       |           .                |        |Enter/Leave|
 *       +           .                +-------+|Plugin     |
 * +-------------+   .                         +-----------+
 * | application |   .
 * |-------------|   .
 * |             |   .
 * |             |   .
 * +-------------+   .
 *                   .
 *    React Core     .  General Purpose Event Plugin System
 */

var alreadyListeningTo = {};
var isMonitoringScrollValue = false;
var reactTopListenersCounter = 0;

// For events like 'submit' which don't consistently bubble (which we trap at a
// lower node than `document`), binding at `document` would cause duplicate
// events so we don't include them here
var topEventMapping = {
  topBlur: 'blur',
  topChange: 'change',
  topClick: 'click',
  topCompositionEnd: 'compositionend',
  topCompositionStart: 'compositionstart',
  topCompositionUpdate: 'compositionupdate',
  topContextMenu: 'contextmenu',
  topCopy: 'copy',
  topCut: 'cut',
  topDoubleClick: 'dblclick',
  topDrag: 'drag',
  topDragEnd: 'dragend',
  topDragEnter: 'dragenter',
  topDragExit: 'dragexit',
  topDragLeave: 'dragleave',
  topDragOver: 'dragover',
  topDragStart: 'dragstart',
  topDrop: 'drop',
  topFocus: 'focus',
  topInput: 'input',
  topKeyDown: 'keydown',
  topKeyPress: 'keypress',
  topKeyUp: 'keyup',
  topMouseDown: 'mousedown',
  topMouseMove: 'mousemove',
  topMouseOut: 'mouseout',
  topMouseOver: 'mouseover',
  topMouseUp: 'mouseup',
  topPaste: 'paste',
  topScroll: 'scroll',
  topSelectionChange: 'selectionchange',
  topTextInput: 'textInput',
  topTouchCancel: 'touchcancel',
  topTouchEnd: 'touchend',
  topTouchMove: 'touchmove',
  topTouchStart: 'touchstart',
  topWheel: 'wheel'
};

/**
 * To ensure no conflicts with other potential React instances on the page
 */
var topListenersIDKey = "_reactListenersID" + String(Math.random()).slice(2);

function getListeningForDocument(mountAt) {
  // In IE8, `mountAt` is a host object and doesn't have `hasOwnProperty`
  // directly.
  if (!Object.prototype.hasOwnProperty.call(mountAt, topListenersIDKey)) {
    mountAt[topListenersIDKey] = reactTopListenersCounter++;
    alreadyListeningTo[mountAt[topListenersIDKey]] = {};
  }
  return alreadyListeningTo[mountAt[topListenersIDKey]];
}

/**
 * `ReactBrowserEventEmitter` is used to attach top-level event listeners. For
 * example:
 *
 *   ReactBrowserEventEmitter.putListener('myID', 'onClick', myFunction);
 *
 * This would allocate a "registration" of `('onClick', myFunction)` on 'myID'.
 *
 * @internal
 */
var ReactBrowserEventEmitter = assign({}, ReactEventEmitterMixin, {

  /**
   * Injectable event backend
   */
  ReactEventListener: null,

  injection: {
    /**
     * @param {object} ReactEventListener
     */
    injectReactEventListener: function(ReactEventListener) {
      ReactEventListener.setHandleTopLevel(
        ReactBrowserEventEmitter.handleTopLevel
      );
      ReactBrowserEventEmitter.ReactEventListener = ReactEventListener;
    }
  },

  /**
   * Sets whether or not any created callbacks should be enabled.
   *
   * @param {boolean} enabled True if callbacks should be enabled.
   */
  setEnabled: function(enabled) {
    if (ReactBrowserEventEmitter.ReactEventListener) {
      ReactBrowserEventEmitter.ReactEventListener.setEnabled(enabled);
    }
  },

  /**
   * @return {boolean} True if callbacks are enabled.
   */
  isEnabled: function() {
    return !!(
      ReactBrowserEventEmitter.ReactEventListener &&
      ReactBrowserEventEmitter.ReactEventListener.isEnabled()
    );
  },

  /**
   * We listen for bubbled touch events on the document object.
   *
   * Firefox v8.01 (and possibly others) exhibited strange behavior when
   * mounting `onmousemove` events at some node that was not the document
   * element. The symptoms were that if your mouse is not moving over something
   * contained within that mount point (for example on the background) the
   * top-level listeners for `onmousemove` won't be called. However, if you
   * register the `mousemove` on the document object, then it will of course
   * catch all `mousemove`s. This along with iOS quirks, justifies restricting
   * top-level listeners to the document object only, at least for these
   * movement types of events and possibly all events.
   *
   * @see http://www.quirksmode.org/blog/archives/2010/09/click_event_del.html
   *
   * Also, `keyup`/`keypress`/`keydown` do not bubble to the window on IE, but
   * they bubble to document.
   *
   * @param {string} registrationName Name of listener (e.g. `onClick`).
   * @param {object} contentDocumentHandle Document which owns the container
   */
  listenTo: function(registrationName, contentDocumentHandle) {
    var mountAt = contentDocumentHandle;
    var isListening = getListeningForDocument(mountAt);
    var dependencies = EventPluginRegistry.
      registrationNameDependencies[registrationName];

    var topLevelTypes = EventConstants.topLevelTypes;
    for (var i = 0, l = dependencies.length; i < l; i++) {
      var dependency = dependencies[i];
      if (!(
            isListening.hasOwnProperty(dependency) &&
            isListening[dependency]
          )) {
        if (dependency === topLevelTypes.topWheel) {
          if (isEventSupported('wheel')) {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'wheel',
              mountAt
            );
          } else if (isEventSupported('mousewheel')) {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'mousewheel',
              mountAt
            );
          } else {
            // Firefox needs to capture a different mouse scroll event.
            // @see http://www.quirksmode.org/dom/events/tests/scroll.html
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topWheel,
              'DOMMouseScroll',
              mountAt
            );
          }
        } else if (dependency === topLevelTypes.topScroll) {

          if (isEventSupported('scroll', true)) {
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topScroll,
              'scroll',
              mountAt
            );
          } else {
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topScroll,
              'scroll',
              ReactBrowserEventEmitter.ReactEventListener.WINDOW_HANDLE
            );
          }
        } else if (dependency === topLevelTypes.topFocus ||
            dependency === topLevelTypes.topBlur) {

          if (isEventSupported('focus', true)) {
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topFocus,
              'focus',
              mountAt
            );
            ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
              topLevelTypes.topBlur,
              'blur',
              mountAt
            );
          } else if (isEventSupported('focusin')) {
            // IE has `focusin` and `focusout` events which bubble.
            // @see http://www.quirksmode.org/blog/archives/2008/04/delegating_the.html
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topFocus,
              'focusin',
              mountAt
            );
            ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
              topLevelTypes.topBlur,
              'focusout',
              mountAt
            );
          }

          // to make sure blur and focus event listeners are only attached once
          isListening[topLevelTypes.topBlur] = true;
          isListening[topLevelTypes.topFocus] = true;
        } else if (topEventMapping.hasOwnProperty(dependency)) {
          ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
            dependency,
            topEventMapping[dependency],
            mountAt
          );
        }

        isListening[dependency] = true;
      }
    }
  },

  trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
    return ReactBrowserEventEmitter.ReactEventListener.trapBubbledEvent(
      topLevelType,
      handlerBaseName,
      handle
    );
  },

  trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
    return ReactBrowserEventEmitter.ReactEventListener.trapCapturedEvent(
      topLevelType,
      handlerBaseName,
      handle
    );
  },

  /**
   * Listens to window scroll and resize events. We cache scroll values so that
   * application code can access them without triggering reflows.
   *
   * NOTE: Scroll events do not bubble.
   *
   * @see http://www.quirksmode.org/dom/events/scroll.html
   */
  ensureScrollValueMonitoring: function(){
    if (!isMonitoringScrollValue) {
      var refresh = ViewportMetrics.refreshScrollValues;
      ReactBrowserEventEmitter.ReactEventListener.monitorScrollValue(refresh);
      isMonitoringScrollValue = true;
    }
  },

  eventNameDispatchConfigs: EventPluginHub.eventNameDispatchConfigs,

  registrationNameModules: EventPluginHub.registrationNameModules,

  putListener: EventPluginHub.putListener,

  getListener: EventPluginHub.getListener,

  deleteListener: EventPluginHub.deleteListener,

  deleteAllListeners: EventPluginHub.deleteAllListeners

});

module.exports = ReactBrowserEventEmitter;

},{"./EventConstants":15,"./EventPluginHub":17,"./EventPluginRegistry":18,"./Object.assign":26,"./ReactEventEmitterMixin":56,"./ViewportMetrics":96,"./isEventSupported":127}],31:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactChildren
 */

"use strict";

var PooledClass = require("./PooledClass");

var traverseAllChildren = require("./traverseAllChildren");
var warning = require("./warning");

var twoArgumentPooler = PooledClass.twoArgumentPooler;
var threeArgumentPooler = PooledClass.threeArgumentPooler;

/**
 * PooledClass representing the bookkeeping associated with performing a child
 * traversal. Allows avoiding binding callbacks.
 *
 * @constructor ForEachBookKeeping
 * @param {!function} forEachFunction Function to perform traversal with.
 * @param {?*} forEachContext Context to perform context with.
 */
function ForEachBookKeeping(forEachFunction, forEachContext) {
  this.forEachFunction = forEachFunction;
  this.forEachContext = forEachContext;
}
PooledClass.addPoolingTo(ForEachBookKeeping, twoArgumentPooler);

function forEachSingleChild(traverseContext, child, name, i) {
  var forEachBookKeeping = traverseContext;
  forEachBookKeeping.forEachFunction.call(
    forEachBookKeeping.forEachContext, child, i);
}

/**
 * Iterates through children that are typically specified as `props.children`.
 *
 * The provided forEachFunc(child, index) will be called for each
 * leaf child.
 *
 * @param {?*} children Children tree container.
 * @param {function(*, int)} forEachFunc.
 * @param {*} forEachContext Context for forEachContext.
 */
function forEachChildren(children, forEachFunc, forEachContext) {
  if (children == null) {
    return children;
  }

  var traverseContext =
    ForEachBookKeeping.getPooled(forEachFunc, forEachContext);
  traverseAllChildren(children, forEachSingleChild, traverseContext);
  ForEachBookKeeping.release(traverseContext);
}

/**
 * PooledClass representing the bookkeeping associated with performing a child
 * mapping. Allows avoiding binding callbacks.
 *
 * @constructor MapBookKeeping
 * @param {!*} mapResult Object containing the ordered map of results.
 * @param {!function} mapFunction Function to perform mapping with.
 * @param {?*} mapContext Context to perform mapping with.
 */
function MapBookKeeping(mapResult, mapFunction, mapContext) {
  this.mapResult = mapResult;
  this.mapFunction = mapFunction;
  this.mapContext = mapContext;
}
PooledClass.addPoolingTo(MapBookKeeping, threeArgumentPooler);

function mapSingleChildIntoContext(traverseContext, child, name, i) {
  var mapBookKeeping = traverseContext;
  var mapResult = mapBookKeeping.mapResult;

  var keyUnique = !mapResult.hasOwnProperty(name);
  ("production" !== process.env.NODE_ENV ? warning(
    keyUnique,
    'ReactChildren.map(...): Encountered two children with the same key, ' +
    '`%s`. Child keys must be unique; when two children share a key, only ' +
    'the first child will be used.',
    name
  ) : null);

  if (keyUnique) {
    var mappedChild =
      mapBookKeeping.mapFunction.call(mapBookKeeping.mapContext, child, i);
    mapResult[name] = mappedChild;
  }
}

/**
 * Maps children that are typically specified as `props.children`.
 *
 * The provided mapFunction(child, key, index) will be called for each
 * leaf child.
 *
 * TODO: This may likely break any calls to `ReactChildren.map` that were
 * previously relying on the fact that we guarded against null children.
 *
 * @param {?*} children Children tree container.
 * @param {function(*, int)} mapFunction.
 * @param {*} mapContext Context for mapFunction.
 * @return {object} Object containing the ordered map of results.
 */
function mapChildren(children, func, context) {
  if (children == null) {
    return children;
  }

  var mapResult = {};
  var traverseContext = MapBookKeeping.getPooled(mapResult, func, context);
  traverseAllChildren(children, mapSingleChildIntoContext, traverseContext);
  MapBookKeeping.release(traverseContext);
  return mapResult;
}

function forEachSingleChildDummy(traverseContext, child, name, i) {
  return null;
}

/**
 * Count the number of children that are typically specified as
 * `props.children`.
 *
 * @param {?*} children Children tree container.
 * @return {number} The number of children.
 */
function countChildren(children, context) {
  return traverseAllChildren(children, forEachSingleChildDummy, null);
}

var ReactChildren = {
  forEach: forEachChildren,
  map: mapChildren,
  count: countChildren
};

module.exports = ReactChildren;

}).call(this,require("ngpmcQ"))
},{"./PooledClass":27,"./traverseAllChildren":144,"./warning":145,"ngpmcQ":176}],32:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactComponent
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactOwner = require("./ReactOwner");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");
var keyMirror = require("./keyMirror");

/**
 * Every React component is in one of these life cycles.
 */
var ComponentLifeCycle = keyMirror({
  /**
   * Mounted components have a DOM node representation and are capable of
   * receiving new props.
   */
  MOUNTED: null,
  /**
   * Unmounted components are inactive and cannot receive new props.
   */
  UNMOUNTED: null
});

var injected = false;

/**
 * Optionally injectable environment dependent cleanup hook. (server vs.
 * browser etc). Example: A browser system caches DOM nodes based on component
 * ID and must remove that cache entry when this instance is unmounted.
 *
 * @private
 */
var unmountIDFromEnvironment = null;

/**
 * The "image" of a component tree, is the platform specific (typically
 * serialized) data that represents a tree of lower level UI building blocks.
 * On the web, this "image" is HTML markup which describes a construction of
 * low level `div` and `span` nodes. Other platforms may have different
 * encoding of this "image". This must be injected.
 *
 * @private
 */
var mountImageIntoNode = null;

/**
 * Components are the basic units of composition in React.
 *
 * Every component accepts a set of keyed input parameters known as "props" that
 * are initialized by the constructor. Once a component is mounted, the props
 * can be mutated using `setProps` or `replaceProps`.
 *
 * Every component is capable of the following operations:
 *
 *   `mountComponent`
 *     Initializes the component, renders markup, and registers event listeners.
 *
 *   `receiveComponent`
 *     Updates the rendered DOM nodes to match the given component.
 *
 *   `unmountComponent`
 *     Releases any resources allocated by this component.
 *
 * Components can also be "owned" by other components. Being owned by another
 * component means being constructed by that component. This is different from
 * being the child of a component, which means having a DOM representation that
 * is a child of the DOM representation of that component.
 *
 * @class ReactComponent
 */
var ReactComponent = {

  injection: {
    injectEnvironment: function(ReactComponentEnvironment) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !injected,
        'ReactComponent: injectEnvironment() can only be called once.'
      ) : invariant(!injected));
      mountImageIntoNode = ReactComponentEnvironment.mountImageIntoNode;
      unmountIDFromEnvironment =
        ReactComponentEnvironment.unmountIDFromEnvironment;
      ReactComponent.BackendIDOperations =
        ReactComponentEnvironment.BackendIDOperations;
      injected = true;
    }
  },

  /**
   * @internal
   */
  LifeCycle: ComponentLifeCycle,

  /**
   * Injected module that provides ability to mutate individual properties.
   * Injected into the base class because many different subclasses need access
   * to this.
   *
   * @internal
   */
  BackendIDOperations: null,

  /**
   * Base functionality for every ReactComponent constructor. Mixed into the
   * `ReactComponent` prototype, but exposed statically for easy access.
   *
   * @lends {ReactComponent.prototype}
   */
  Mixin: {

    /**
     * Checks whether or not this component is mounted.
     *
     * @return {boolean} True if mounted, false otherwise.
     * @final
     * @protected
     */
    isMounted: function() {
      return this._lifeCycleState === ComponentLifeCycle.MOUNTED;
    },

    /**
     * Sets a subset of the props.
     *
     * @param {object} partialProps Subset of the next props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @public
     */
    setProps: function(partialProps, callback) {
      // Merge with the pending element if it exists, otherwise with existing
      // element props.
      var element = this._pendingElement || this._currentElement;
      this.replaceProps(
        assign({}, element.props, partialProps),
        callback
      );
    },

    /**
     * Replaces all of the props.
     *
     * @param {object} props New props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @public
     */
    replaceProps: function(props, callback) {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'replaceProps(...): Can only update a mounted component.'
      ) : invariant(this.isMounted()));
      ("production" !== process.env.NODE_ENV ? invariant(
        this._mountDepth === 0,
        'replaceProps(...): You called `setProps` or `replaceProps` on a ' +
        'component with a parent. This is an anti-pattern since props will ' +
        'get reactively updated when rendered. Instead, change the owner\'s ' +
        '`render` method to pass the correct value as props to the component ' +
        'where it is created.'
      ) : invariant(this._mountDepth === 0));
      // This is a deoptimized path. We optimize for always having a element.
      // This creates an extra internal element.
      this._pendingElement = ReactElement.cloneAndReplaceProps(
        this._pendingElement || this._currentElement,
        props
      );
      ReactUpdates.enqueueUpdate(this, callback);
    },

    /**
     * Schedule a partial update to the props. Only used for internal testing.
     *
     * @param {object} partialProps Subset of the next props.
     * @param {?function} callback Called after props are updated.
     * @final
     * @internal
     */
    _setPropsInternal: function(partialProps, callback) {
      // This is a deoptimized path. We optimize for always having a element.
      // This creates an extra internal element.
      var element = this._pendingElement || this._currentElement;
      this._pendingElement = ReactElement.cloneAndReplaceProps(
        element,
        assign({}, element.props, partialProps)
      );
      ReactUpdates.enqueueUpdate(this, callback);
    },

    /**
     * Base constructor for all React components.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.construct.call(this, ...)`.
     *
     * @param {ReactElement} element
     * @internal
     */
    construct: function(element) {
      // This is the public exposed props object after it has been processed
      // with default props. The element's props represents the true internal
      // state of the props.
      this.props = element.props;
      // Record the component responsible for creating this component.
      // This is accessible through the element but we maintain an extra
      // field for compatibility with devtools and as a way to make an
      // incremental update. TODO: Consider deprecating this field.
      this._owner = element._owner;

      // All components start unmounted.
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;

      // See ReactUpdates.
      this._pendingCallbacks = null;

      // We keep the old element and a reference to the pending element
      // to track updates.
      this._currentElement = element;
      this._pendingElement = null;
    },

    /**
     * Initializes the component, renders markup, and registers event listeners.
     *
     * NOTE: This does not insert any nodes into the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.mountComponent.call(this, ...)`.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
     * @param {number} mountDepth number of components in the owner hierarchy.
     * @return {?string} Rendered markup to be inserted into the DOM.
     * @internal
     */
    mountComponent: function(rootID, transaction, mountDepth) {
      ("production" !== process.env.NODE_ENV ? invariant(
        !this.isMounted(),
        'mountComponent(%s, ...): Can only mount an unmounted component. ' +
        'Make sure to avoid storing components between renders or reusing a ' +
        'single component instance in multiple places.',
        rootID
      ) : invariant(!this.isMounted()));
      var ref = this._currentElement.ref;
      if (ref != null) {
        var owner = this._currentElement._owner;
        ReactOwner.addComponentAsRefTo(this, ref, owner);
      }
      this._rootNodeID = rootID;
      this._lifeCycleState = ComponentLifeCycle.MOUNTED;
      this._mountDepth = mountDepth;
      // Effectively: return '';
    },

    /**
     * Releases any resources allocated by `mountComponent`.
     *
     * NOTE: This does not remove any nodes from the DOM.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.unmountComponent.call(this)`.
     *
     * @internal
     */
    unmountComponent: function() {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'unmountComponent(): Can only unmount a mounted component.'
      ) : invariant(this.isMounted()));
      var ref = this._currentElement.ref;
      if (ref != null) {
        ReactOwner.removeComponentAsRefFrom(this, ref, this._owner);
      }
      unmountIDFromEnvironment(this._rootNodeID);
      this._rootNodeID = null;
      this._lifeCycleState = ComponentLifeCycle.UNMOUNTED;
    },

    /**
     * Given a new instance of this component, updates the rendered DOM nodes
     * as if that instance was rendered instead.
     *
     * Subclasses that override this method should make sure to invoke
     * `ReactComponent.Mixin.receiveComponent.call(this, ...)`.
     *
     * @param {object} nextComponent Next set of properties.
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    receiveComponent: function(nextElement, transaction) {
      ("production" !== process.env.NODE_ENV ? invariant(
        this.isMounted(),
        'receiveComponent(...): Can only update a mounted component.'
      ) : invariant(this.isMounted()));
      this._pendingElement = nextElement;
      this.performUpdateIfNecessary(transaction);
    },

    /**
     * If `_pendingElement` is set, update the component.
     *
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    performUpdateIfNecessary: function(transaction) {
      if (this._pendingElement == null) {
        return;
      }
      var prevElement = this._currentElement;
      var nextElement = this._pendingElement;
      this._currentElement = nextElement;
      this.props = nextElement.props;
      this._owner = nextElement._owner;
      this._pendingElement = null;
      this.updateComponent(transaction, prevElement);
    },

    /**
     * Updates the component's currently mounted representation.
     *
     * @param {ReactReconcileTransaction} transaction
     * @param {object} prevElement
     * @internal
     */
    updateComponent: function(transaction, prevElement) {
      var nextElement = this._currentElement;

      // If either the owner or a `ref` has changed, make sure the newest owner
      // has stored a reference to `this`, and the previous owner (if different)
      // has forgotten the reference to `this`. We use the element instead
      // of the public this.props because the post processing cannot determine
      // a ref. The ref conceptually lives on the element.

      // TODO: Should this even be possible? The owner cannot change because
      // it's forbidden by shouldUpdateReactComponent. The ref can change
      // if you swap the keys of but not the refs. Reconsider where this check
      // is made. It probably belongs where the key checking and
      // instantiateReactComponent is done.

      if (nextElement._owner !== prevElement._owner ||
          nextElement.ref !== prevElement.ref) {
        if (prevElement.ref != null) {
          ReactOwner.removeComponentAsRefFrom(
            this, prevElement.ref, prevElement._owner
          );
        }
        // Correct, even if the owner is the same, and only the ref has changed.
        if (nextElement.ref != null) {
          ReactOwner.addComponentAsRefTo(
            this,
            nextElement.ref,
            nextElement._owner
          );
        }
      }
    },

    /**
     * Mounts this component and inserts it into the DOM.
     *
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @internal
     * @see {ReactMount.render}
     */
    mountComponentIntoNode: function(rootID, container, shouldReuseMarkup) {
      var transaction = ReactUpdates.ReactReconcileTransaction.getPooled();
      transaction.perform(
        this._mountComponentIntoNode,
        this,
        rootID,
        container,
        transaction,
        shouldReuseMarkup
      );
      ReactUpdates.ReactReconcileTransaction.release(transaction);
    },

    /**
     * @param {string} rootID DOM ID of the root node.
     * @param {DOMElement} container DOM element to mount into.
     * @param {ReactReconcileTransaction} transaction
     * @param {boolean} shouldReuseMarkup If true, do not insert markup
     * @final
     * @private
     */
    _mountComponentIntoNode: function(
        rootID,
        container,
        transaction,
        shouldReuseMarkup) {
      var markup = this.mountComponent(rootID, transaction, 0);
      mountImageIntoNode(markup, container, shouldReuseMarkup);
    },

    /**
     * Checks if this component is owned by the supplied `owner` component.
     *
     * @param {ReactComponent} owner Component to check.
     * @return {boolean} True if `owners` owns this component.
     * @final
     * @internal
     */
    isOwnedBy: function(owner) {
      return this._owner === owner;
    },

    /**
     * Gets another component, that shares the same owner as this one, by ref.
     *
     * @param {string} ref of a sibling Component.
     * @return {?ReactComponent} the actual sibling Component.
     * @final
     * @internal
     */
    getSiblingByRef: function(ref) {
      var owner = this._owner;
      if (!owner || !owner.refs) {
        return null;
      }
      return owner.refs[ref];
    }
  }
};

module.exports = ReactComponent;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./ReactElement":52,"./ReactOwner":67,"./ReactUpdates":79,"./invariant":126,"./keyMirror":132,"ngpmcQ":176}],33:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactComponentBrowserEnvironment
 */

/*jslint evil: true */

"use strict";

var ReactDOMIDOperations = require("./ReactDOMIDOperations");
var ReactMarkupChecksum = require("./ReactMarkupChecksum");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");
var ReactReconcileTransaction = require("./ReactReconcileTransaction");

var getReactRootElementInContainer = require("./getReactRootElementInContainer");
var invariant = require("./invariant");
var setInnerHTML = require("./setInnerHTML");


var ELEMENT_NODE_TYPE = 1;
var DOC_NODE_TYPE = 9;


/**
 * Abstracts away all functionality of `ReactComponent` requires knowledge of
 * the browser context.
 */
var ReactComponentBrowserEnvironment = {
  ReactReconcileTransaction: ReactReconcileTransaction,

  BackendIDOperations: ReactDOMIDOperations,

  /**
   * If a particular environment requires that some resources be cleaned up,
   * specify this in the injected Mixin. In the DOM, we would likely want to
   * purge any cached node ID lookups.
   *
   * @private
   */
  unmountIDFromEnvironment: function(rootNodeID) {
    ReactMount.purgeID(rootNodeID);
  },

  /**
   * @param {string} markup Markup string to place into the DOM Element.
   * @param {DOMElement} container DOM Element to insert markup into.
   * @param {boolean} shouldReuseMarkup Should reuse the existing markup in the
   * container if possible.
   */
  mountImageIntoNode: ReactPerf.measure(
    'ReactComponentBrowserEnvironment',
    'mountImageIntoNode',
    function(markup, container, shouldReuseMarkup) {
      ("production" !== process.env.NODE_ENV ? invariant(
        container && (
          container.nodeType === ELEMENT_NODE_TYPE ||
            container.nodeType === DOC_NODE_TYPE
        ),
        'mountComponentIntoNode(...): Target container is not valid.'
      ) : invariant(container && (
        container.nodeType === ELEMENT_NODE_TYPE ||
          container.nodeType === DOC_NODE_TYPE
      )));

      if (shouldReuseMarkup) {
        if (ReactMarkupChecksum.canReuseMarkup(
          markup,
          getReactRootElementInContainer(container))) {
          return;
        } else {
          ("production" !== process.env.NODE_ENV ? invariant(
            container.nodeType !== DOC_NODE_TYPE,
            'You\'re trying to render a component to the document using ' +
            'server rendering but the checksum was invalid. This usually ' +
            'means you rendered a different component type or props on ' +
            'the client from the one on the server, or your render() ' +
            'methods are impure. React cannot handle this case due to ' +
            'cross-browser quirks by rendering at the document root. You ' +
            'should look for environment dependent code in your components ' +
            'and ensure the props are the same client and server side.'
          ) : invariant(container.nodeType !== DOC_NODE_TYPE));

          if ("production" !== process.env.NODE_ENV) {
            console.warn(
              'React attempted to use reuse markup in a container but the ' +
              'checksum was invalid. This generally means that you are ' +
              'using server rendering and the markup generated on the ' +
              'server was not what the client was expecting. React injected ' +
              'new markup to compensate which works but you have lost many ' +
              'of the benefits of server rendering. Instead, figure out ' +
              'why the markup being generated is different on the client ' +
              'or server.'
            );
          }
        }
      }

      ("production" !== process.env.NODE_ENV ? invariant(
        container.nodeType !== DOC_NODE_TYPE,
        'You\'re trying to render a component to the document but ' +
          'you didn\'t use server rendering. We can\'t do this ' +
          'without using server rendering due to cross-browser quirks. ' +
          'See renderComponentToString() for server rendering.'
      ) : invariant(container.nodeType !== DOC_NODE_TYPE));

      setInnerHTML(container, markup);
    }
  )
};

module.exports = ReactComponentBrowserEnvironment;

}).call(this,require("ngpmcQ"))
},{"./ReactDOMIDOperations":41,"./ReactMarkupChecksum":62,"./ReactMount":63,"./ReactPerf":68,"./ReactReconcileTransaction":74,"./getReactRootElementInContainer":120,"./invariant":126,"./setInnerHTML":140,"ngpmcQ":176}],34:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactCompositeComponent
 */

"use strict";

var ReactComponent = require("./ReactComponent");
var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactErrorUtils = require("./ReactErrorUtils");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactOwner = require("./ReactOwner");
var ReactPerf = require("./ReactPerf");
var ReactPropTransferer = require("./ReactPropTransferer");
var ReactPropTypeLocations = require("./ReactPropTypeLocations");
var ReactPropTypeLocationNames = require("./ReactPropTypeLocationNames");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");
var keyMirror = require("./keyMirror");
var keyOf = require("./keyOf");
var monitorCodeUse = require("./monitorCodeUse");
var mapObject = require("./mapObject");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");
var warning = require("./warning");

var MIXINS_KEY = keyOf({mixins: null});

/**
 * Policies that describe methods in `ReactCompositeComponentInterface`.
 */
var SpecPolicy = keyMirror({
  /**
   * These methods may be defined only once by the class specification or mixin.
   */
  DEFINE_ONCE: null,
  /**
   * These methods may be defined by both the class specification and mixins.
   * Subsequent definitions will be chained. These methods must return void.
   */
  DEFINE_MANY: null,
  /**
   * These methods are overriding the base ReactCompositeComponent class.
   */
  OVERRIDE_BASE: null,
  /**
   * These methods are similar to DEFINE_MANY, except we assume they return
   * objects. We try to merge the keys of the return values of all the mixed in
   * functions. If there is a key conflict we throw.
   */
  DEFINE_MANY_MERGED: null
});


var injectedMixins = [];

/**
 * Composite components are higher-level components that compose other composite
 * or native components.
 *
 * To create a new type of `ReactCompositeComponent`, pass a specification of
 * your new class to `React.createClass`. The only requirement of your class
 * specification is that you implement a `render` method.
 *
 *   var MyComponent = React.createClass({
 *     render: function() {
 *       return <div>Hello World</div>;
 *     }
 *   });
 *
 * The class specification supports a specific protocol of methods that have
 * special meaning (e.g. `render`). See `ReactCompositeComponentInterface` for
 * more the comprehensive protocol. Any other properties and methods in the
 * class specification will available on the prototype.
 *
 * @interface ReactCompositeComponentInterface
 * @internal
 */
var ReactCompositeComponentInterface = {

  /**
   * An array of Mixin objects to include when defining your component.
   *
   * @type {array}
   * @optional
   */
  mixins: SpecPolicy.DEFINE_MANY,

  /**
   * An object containing properties and methods that should be defined on
   * the component's constructor instead of its prototype (static methods).
   *
   * @type {object}
   * @optional
   */
  statics: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of prop types for this component.
   *
   * @type {object}
   * @optional
   */
  propTypes: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of context types for this component.
   *
   * @type {object}
   * @optional
   */
  contextTypes: SpecPolicy.DEFINE_MANY,

  /**
   * Definition of context types this component sets for its children.
   *
   * @type {object}
   * @optional
   */
  childContextTypes: SpecPolicy.DEFINE_MANY,

  // ==== Definition methods ====

  /**
   * Invoked when the component is mounted. Values in the mapping will be set on
   * `this.props` if that prop is not specified (i.e. using an `in` check).
   *
   * This method is invoked before `getInitialState` and therefore cannot rely
   * on `this.state` or use `this.setState`.
   *
   * @return {object}
   * @optional
   */
  getDefaultProps: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * Invoked once before the component is mounted. The return value will be used
   * as the initial value of `this.state`.
   *
   *   getInitialState: function() {
   *     return {
   *       isOn: false,
   *       fooBaz: new BazFoo()
   *     }
   *   }
   *
   * @return {object}
   * @optional
   */
  getInitialState: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * @return {object}
   * @optional
   */
  getChildContext: SpecPolicy.DEFINE_MANY_MERGED,

  /**
   * Uses props from `this.props` and state from `this.state` to render the
   * structure of the component.
   *
   * No guarantees are made about when or how often this method is invoked, so
   * it must not have side effects.
   *
   *   render: function() {
   *     var name = this.props.name;
   *     return <div>Hello, {name}!</div>;
   *   }
   *
   * @return {ReactComponent}
   * @nosideeffects
   * @required
   */
  render: SpecPolicy.DEFINE_ONCE,



  // ==== Delegate methods ====

  /**
   * Invoked when the component is initially created and about to be mounted.
   * This may have side effects, but any external subscriptions or data created
   * by this method must be cleaned up in `componentWillUnmount`.
   *
   * @optional
   */
  componentWillMount: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component has been mounted and has a DOM representation.
   * However, there is no guarantee that the DOM node is in the document.
   *
   * Use this as an opportunity to operate on the DOM when the component has
   * been mounted (initialized and rendered) for the first time.
   *
   * @param {DOMElement} rootNode DOM element representing the component.
   * @optional
   */
  componentDidMount: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked before the component receives new props.
   *
   * Use this as an opportunity to react to a prop transition by updating the
   * state using `this.setState`. Current props are accessed via `this.props`.
   *
   *   componentWillReceiveProps: function(nextProps, nextContext) {
   *     this.setState({
   *       likesIncreasing: nextProps.likeCount > this.props.likeCount
   *     });
   *   }
   *
   * NOTE: There is no equivalent `componentWillReceiveState`. An incoming prop
   * transition may cause a state change, but the opposite is not true. If you
   * need it, you are probably looking for `componentWillUpdate`.
   *
   * @param {object} nextProps
   * @optional
   */
  componentWillReceiveProps: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked while deciding if the component should be updated as a result of
   * receiving new props, state and/or context.
   *
   * Use this as an opportunity to `return false` when you're certain that the
   * transition to the new props/state/context will not require a component
   * update.
   *
   *   shouldComponentUpdate: function(nextProps, nextState, nextContext) {
   *     return !equal(nextProps, this.props) ||
   *       !equal(nextState, this.state) ||
   *       !equal(nextContext, this.context);
   *   }
   *
   * @param {object} nextProps
   * @param {?object} nextState
   * @param {?object} nextContext
   * @return {boolean} True if the component should update.
   * @optional
   */
  shouldComponentUpdate: SpecPolicy.DEFINE_ONCE,

  /**
   * Invoked when the component is about to update due to a transition from
   * `this.props`, `this.state` and `this.context` to `nextProps`, `nextState`
   * and `nextContext`.
   *
   * Use this as an opportunity to perform preparation before an update occurs.
   *
   * NOTE: You **cannot** use `this.setState()` in this method.
   *
   * @param {object} nextProps
   * @param {?object} nextState
   * @param {?object} nextContext
   * @param {ReactReconcileTransaction} transaction
   * @optional
   */
  componentWillUpdate: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component's DOM representation has been updated.
   *
   * Use this as an opportunity to operate on the DOM when the component has
   * been updated.
   *
   * @param {object} prevProps
   * @param {?object} prevState
   * @param {?object} prevContext
   * @param {DOMElement} rootNode DOM element representing the component.
   * @optional
   */
  componentDidUpdate: SpecPolicy.DEFINE_MANY,

  /**
   * Invoked when the component is about to be removed from its parent and have
   * its DOM representation destroyed.
   *
   * Use this as an opportunity to deallocate any external resources.
   *
   * NOTE: There is no `componentDidUnmount` since your component will have been
   * destroyed by that point.
   *
   * @optional
   */
  componentWillUnmount: SpecPolicy.DEFINE_MANY,



  // ==== Advanced methods ====

  /**
   * Updates the component's currently mounted DOM representation.
   *
   * By default, this implements React's rendering and reconciliation algorithm.
   * Sophisticated clients may wish to override this.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   * @overridable
   */
  updateComponent: SpecPolicy.OVERRIDE_BASE

};

/**
 * Mapping from class specification keys to special processing functions.
 *
 * Although these are declared like instance properties in the specification
 * when defining classes using `React.createClass`, they are actually static
 * and are accessible on the constructor instead of the prototype. Despite
 * being static, they must be defined outside of the "statics" key under
 * which all other static methods are defined.
 */
var RESERVED_SPEC_KEYS = {
  displayName: function(Constructor, displayName) {
    Constructor.displayName = displayName;
  },
  mixins: function(Constructor, mixins) {
    if (mixins) {
      for (var i = 0; i < mixins.length; i++) {
        mixSpecIntoComponent(Constructor, mixins[i]);
      }
    }
  },
  childContextTypes: function(Constructor, childContextTypes) {
    validateTypeDef(
      Constructor,
      childContextTypes,
      ReactPropTypeLocations.childContext
    );
    Constructor.childContextTypes = assign(
      {},
      Constructor.childContextTypes,
      childContextTypes
    );
  },
  contextTypes: function(Constructor, contextTypes) {
    validateTypeDef(
      Constructor,
      contextTypes,
      ReactPropTypeLocations.context
    );
    Constructor.contextTypes = assign(
      {},
      Constructor.contextTypes,
      contextTypes
    );
  },
  /**
   * Special case getDefaultProps which should move into statics but requires
   * automatic merging.
   */
  getDefaultProps: function(Constructor, getDefaultProps) {
    if (Constructor.getDefaultProps) {
      Constructor.getDefaultProps = createMergedResultFunction(
        Constructor.getDefaultProps,
        getDefaultProps
      );
    } else {
      Constructor.getDefaultProps = getDefaultProps;
    }
  },
  propTypes: function(Constructor, propTypes) {
    validateTypeDef(
      Constructor,
      propTypes,
      ReactPropTypeLocations.prop
    );
    Constructor.propTypes = assign(
      {},
      Constructor.propTypes,
      propTypes
    );
  },
  statics: function(Constructor, statics) {
    mixStaticSpecIntoComponent(Constructor, statics);
  }
};

function getDeclarationErrorAddendum(component) {
  var owner = component._owner || null;
  if (owner && owner.constructor && owner.constructor.displayName) {
    return ' Check the render method of `' + owner.constructor.displayName +
      '`.';
  }
  return '';
}

function validateTypeDef(Constructor, typeDef, location) {
  for (var propName in typeDef) {
    if (typeDef.hasOwnProperty(propName)) {
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof typeDef[propName] == 'function',
        '%s: %s type `%s` is invalid; it must be a function, usually from ' +
        'React.PropTypes.',
        Constructor.displayName || 'ReactCompositeComponent',
        ReactPropTypeLocationNames[location],
        propName
      ) : invariant(typeof typeDef[propName] == 'function'));
    }
  }
}

function validateMethodOverride(proto, name) {
  var specPolicy = ReactCompositeComponentInterface.hasOwnProperty(name) ?
    ReactCompositeComponentInterface[name] :
    null;

  // Disallow overriding of base class methods unless explicitly allowed.
  if (ReactCompositeComponentMixin.hasOwnProperty(name)) {
    ("production" !== process.env.NODE_ENV ? invariant(
      specPolicy === SpecPolicy.OVERRIDE_BASE,
      'ReactCompositeComponentInterface: You are attempting to override ' +
      '`%s` from your class specification. Ensure that your method names ' +
      'do not overlap with React methods.',
      name
    ) : invariant(specPolicy === SpecPolicy.OVERRIDE_BASE));
  }

  // Disallow defining methods more than once unless explicitly allowed.
  if (proto.hasOwnProperty(name)) {
    ("production" !== process.env.NODE_ENV ? invariant(
      specPolicy === SpecPolicy.DEFINE_MANY ||
      specPolicy === SpecPolicy.DEFINE_MANY_MERGED,
      'ReactCompositeComponentInterface: You are attempting to define ' +
      '`%s` on your component more than once. This conflict may be due ' +
      'to a mixin.',
      name
    ) : invariant(specPolicy === SpecPolicy.DEFINE_MANY ||
    specPolicy === SpecPolicy.DEFINE_MANY_MERGED));
  }
}

function validateLifeCycleOnReplaceState(instance) {
  var compositeLifeCycleState = instance._compositeLifeCycleState;
  ("production" !== process.env.NODE_ENV ? invariant(
    instance.isMounted() ||
      compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
    'replaceState(...): Can only update a mounted or mounting component.'
  ) : invariant(instance.isMounted() ||
    compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactCurrentOwner.current == null,
    'replaceState(...): Cannot update during an existing state transition ' +
    '(such as within `render`). Render methods should be a pure function ' +
    'of props and state.'
  ) : invariant(ReactCurrentOwner.current == null));
  ("production" !== process.env.NODE_ENV ? invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING,
    'replaceState(...): Cannot update while unmounting component. This ' +
    'usually means you called setState() on an unmounted component.'
  ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING));
}

/**
 * Mixin helper which handles policy validation and reserved
 * specification keys when building `ReactCompositeComponent` classses.
 */
function mixSpecIntoComponent(Constructor, spec) {
  if (!spec) {
    return;
  }

  ("production" !== process.env.NODE_ENV ? invariant(
    !ReactLegacyElement.isValidFactory(spec),
    'ReactCompositeComponent: You\'re attempting to ' +
    'use a component class as a mixin. Instead, just use a regular object.'
  ) : invariant(!ReactLegacyElement.isValidFactory(spec)));
  ("production" !== process.env.NODE_ENV ? invariant(
    !ReactElement.isValidElement(spec),
    'ReactCompositeComponent: You\'re attempting to ' +
    'use a component as a mixin. Instead, just use a regular object.'
  ) : invariant(!ReactElement.isValidElement(spec)));

  var proto = Constructor.prototype;

  // By handling mixins before any other properties, we ensure the same
  // chaining order is applied to methods with DEFINE_MANY policy, whether
  // mixins are listed before or after these methods in the spec.
  if (spec.hasOwnProperty(MIXINS_KEY)) {
    RESERVED_SPEC_KEYS.mixins(Constructor, spec.mixins);
  }

  for (var name in spec) {
    if (!spec.hasOwnProperty(name)) {
      continue;
    }

    if (name === MIXINS_KEY) {
      // We have already handled mixins in a special case above
      continue;
    }

    var property = spec[name];
    validateMethodOverride(proto, name);

    if (RESERVED_SPEC_KEYS.hasOwnProperty(name)) {
      RESERVED_SPEC_KEYS[name](Constructor, property);
    } else {
      // Setup methods on prototype:
      // The following member methods should not be automatically bound:
      // 1. Expected ReactCompositeComponent methods (in the "interface").
      // 2. Overridden methods (that were mixed in).
      var isCompositeComponentMethod =
        ReactCompositeComponentInterface.hasOwnProperty(name);
      var isAlreadyDefined = proto.hasOwnProperty(name);
      var markedDontBind = property && property.__reactDontBind;
      var isFunction = typeof property === 'function';
      var shouldAutoBind =
        isFunction &&
        !isCompositeComponentMethod &&
        !isAlreadyDefined &&
        !markedDontBind;

      if (shouldAutoBind) {
        if (!proto.__reactAutoBindMap) {
          proto.__reactAutoBindMap = {};
        }
        proto.__reactAutoBindMap[name] = property;
        proto[name] = property;
      } else {
        if (isAlreadyDefined) {
          var specPolicy = ReactCompositeComponentInterface[name];

          // These cases should already be caught by validateMethodOverride
          ("production" !== process.env.NODE_ENV ? invariant(
            isCompositeComponentMethod && (
              specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
              specPolicy === SpecPolicy.DEFINE_MANY
            ),
            'ReactCompositeComponent: Unexpected spec policy %s for key %s ' +
            'when mixing in component specs.',
            specPolicy,
            name
          ) : invariant(isCompositeComponentMethod && (
            specPolicy === SpecPolicy.DEFINE_MANY_MERGED ||
            specPolicy === SpecPolicy.DEFINE_MANY
          )));

          // For methods which are defined more than once, call the existing
          // methods before calling the new property, merging if appropriate.
          if (specPolicy === SpecPolicy.DEFINE_MANY_MERGED) {
            proto[name] = createMergedResultFunction(proto[name], property);
          } else if (specPolicy === SpecPolicy.DEFINE_MANY) {
            proto[name] = createChainedFunction(proto[name], property);
          }
        } else {
          proto[name] = property;
          if ("production" !== process.env.NODE_ENV) {
            // Add verbose displayName to the function, which helps when looking
            // at profiling tools.
            if (typeof property === 'function' && spec.displayName) {
              proto[name].displayName = spec.displayName + '_' + name;
            }
          }
        }
      }
    }
  }
}

function mixStaticSpecIntoComponent(Constructor, statics) {
  if (!statics) {
    return;
  }
  for (var name in statics) {
    var property = statics[name];
    if (!statics.hasOwnProperty(name)) {
      continue;
    }

    var isReserved = name in RESERVED_SPEC_KEYS;
    ("production" !== process.env.NODE_ENV ? invariant(
      !isReserved,
      'ReactCompositeComponent: You are attempting to define a reserved ' +
      'property, `%s`, that shouldn\'t be on the "statics" key. Define it ' +
      'as an instance property instead; it will still be accessible on the ' +
      'constructor.',
      name
    ) : invariant(!isReserved));

    var isInherited = name in Constructor;
    ("production" !== process.env.NODE_ENV ? invariant(
      !isInherited,
      'ReactCompositeComponent: You are attempting to define ' +
      '`%s` on your component more than once. This conflict may be ' +
      'due to a mixin.',
      name
    ) : invariant(!isInherited));
    Constructor[name] = property;
  }
}

/**
 * Merge two objects, but throw if both contain the same key.
 *
 * @param {object} one The first object, which is mutated.
 * @param {object} two The second object
 * @return {object} one after it has been mutated to contain everything in two.
 */
function mergeObjectsWithNoDuplicateKeys(one, two) {
  ("production" !== process.env.NODE_ENV ? invariant(
    one && two && typeof one === 'object' && typeof two === 'object',
    'mergeObjectsWithNoDuplicateKeys(): Cannot merge non-objects'
  ) : invariant(one && two && typeof one === 'object' && typeof two === 'object'));

  mapObject(two, function(value, key) {
    ("production" !== process.env.NODE_ENV ? invariant(
      one[key] === undefined,
      'mergeObjectsWithNoDuplicateKeys(): ' +
      'Tried to merge two objects with the same key: `%s`. This conflict ' +
      'may be due to a mixin; in particular, this may be caused by two ' +
      'getInitialState() or getDefaultProps() methods returning objects ' +
      'with clashing keys.',
      key
    ) : invariant(one[key] === undefined));
    one[key] = value;
  });
  return one;
}

/**
 * Creates a function that invokes two functions and merges their return values.
 *
 * @param {function} one Function to invoke first.
 * @param {function} two Function to invoke second.
 * @return {function} Function that invokes the two argument functions.
 * @private
 */
function createMergedResultFunction(one, two) {
  return function mergedResult() {
    var a = one.apply(this, arguments);
    var b = two.apply(this, arguments);
    if (a == null) {
      return b;
    } else if (b == null) {
      return a;
    }
    return mergeObjectsWithNoDuplicateKeys(a, b);
  };
}

/**
 * Creates a function that invokes two functions and ignores their return vales.
 *
 * @param {function} one Function to invoke first.
 * @param {function} two Function to invoke second.
 * @return {function} Function that invokes the two argument functions.
 * @private
 */
function createChainedFunction(one, two) {
  return function chainedFunction() {
    one.apply(this, arguments);
    two.apply(this, arguments);
  };
}

/**
 * `ReactCompositeComponent` maintains an auxiliary life cycle state in
 * `this._compositeLifeCycleState` (which can be null).
 *
 * This is different from the life cycle state maintained by `ReactComponent` in
 * `this._lifeCycleState`. The following diagram shows how the states overlap in
 * time. There are times when the CompositeLifeCycle is null - at those times it
 * is only meaningful to look at ComponentLifeCycle alone.
 *
 * Top Row: ReactComponent.ComponentLifeCycle
 * Low Row: ReactComponent.CompositeLifeCycle
 *
 * +-------+---------------------------------+--------+
 * |  UN   |             MOUNTED             |   UN   |
 * |MOUNTED|                                 | MOUNTED|
 * +-------+---------------------------------+--------+
 * |       ^--------+   +-------+   +--------^        |
 * |       |        |   |       |   |        |        |
 * |    0--|MOUNTING|-0-|RECEIVE|-0-|   UN   |--->0   |
 * |       |        |   |PROPS  |   |MOUNTING|        |
 * |       |        |   |       |   |        |        |
 * |       |        |   |       |   |        |        |
 * |       +--------+   +-------+   +--------+        |
 * |       |                                 |        |
 * +-------+---------------------------------+--------+
 */
var CompositeLifeCycle = keyMirror({
  /**
   * Components in the process of being mounted respond to state changes
   * differently.
   */
  MOUNTING: null,
  /**
   * Components in the process of being unmounted are guarded against state
   * changes.
   */
  UNMOUNTING: null,
  /**
   * Components that are mounted and receiving new props respond to state
   * changes differently.
   */
  RECEIVING_PROPS: null
});

/**
 * @lends {ReactCompositeComponent.prototype}
 */
var ReactCompositeComponentMixin = {

  /**
   * Base constructor for all composite component.
   *
   * @param {ReactElement} element
   * @final
   * @internal
   */
  construct: function(element) {
    // Children can be either an array or more than one argument
    ReactComponent.Mixin.construct.apply(this, arguments);
    ReactOwner.Mixin.construct.apply(this, arguments);

    this.state = null;
    this._pendingState = null;

    // This is the public post-processed context. The real context and pending
    // context lives on the element.
    this.context = null;

    this._compositeLifeCycleState = null;
  },

  /**
   * Checks whether or not this composite component is mounted.
   * @return {boolean} True if mounted, false otherwise.
   * @protected
   * @final
   */
  isMounted: function() {
    return ReactComponent.Mixin.isMounted.call(this) &&
      this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING;
  },

  /**
   * Initializes the component, renders markup, and registers event listeners.
   *
   * @param {string} rootID DOM ID of the root node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {?string} Rendered markup to be inserted into the DOM.
   * @final
   * @internal
   */
  mountComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    'mountComponent',
    function(rootID, transaction, mountDepth) {
      ReactComponent.Mixin.mountComponent.call(
        this,
        rootID,
        transaction,
        mountDepth
      );
      this._compositeLifeCycleState = CompositeLifeCycle.MOUNTING;

      if (this.__reactAutoBindMap) {
        this._bindAutoBindMethods();
      }

      this.context = this._processContext(this._currentElement._context);
      this.props = this._processProps(this.props);

      this.state = this.getInitialState ? this.getInitialState() : null;
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof this.state === 'object' && !Array.isArray(this.state),
        '%s.getInitialState(): must return an object or null',
        this.constructor.displayName || 'ReactCompositeComponent'
      ) : invariant(typeof this.state === 'object' && !Array.isArray(this.state)));

      this._pendingState = null;
      this._pendingForceUpdate = false;

      if (this.componentWillMount) {
        this.componentWillMount();
        // When mounting, calls to `setState` by `componentWillMount` will set
        // `this._pendingState` without triggering a re-render.
        if (this._pendingState) {
          this.state = this._pendingState;
          this._pendingState = null;
        }
      }

      this._renderedComponent = instantiateReactComponent(
        this._renderValidatedComponent(),
        this._currentElement.type // The wrapping type
      );

      // Done with mounting, `setState` will now trigger UI changes.
      this._compositeLifeCycleState = null;
      var markup = this._renderedComponent.mountComponent(
        rootID,
        transaction,
        mountDepth + 1
      );
      if (this.componentDidMount) {
        transaction.getReactMountReady().enqueue(this.componentDidMount, this);
      }
      return markup;
    }
  ),

  /**
   * Releases any resources allocated by `mountComponent`.
   *
   * @final
   * @internal
   */
  unmountComponent: function() {
    this._compositeLifeCycleState = CompositeLifeCycle.UNMOUNTING;
    if (this.componentWillUnmount) {
      this.componentWillUnmount();
    }
    this._compositeLifeCycleState = null;

    this._renderedComponent.unmountComponent();
    this._renderedComponent = null;

    ReactComponent.Mixin.unmountComponent.call(this);

    // Some existing components rely on this.props even after they've been
    // destroyed (in event handlers).
    // TODO: this.props = null;
    // TODO: this.state = null;
  },

  /**
   * Sets a subset of the state. Always use this or `replaceState` to mutate
   * state. You should treat `this.state` as immutable.
   *
   * There is no guarantee that `this.state` will be immediately updated, so
   * accessing `this.state` after calling this method may return the old value.
   *
   * There is no guarantee that calls to `setState` will run synchronously,
   * as they may eventually be batched together.  You can provide an optional
   * callback that will be executed when the call to setState is actually
   * completed.
   *
   * @param {object} partialState Next partial state to be merged with state.
   * @param {?function} callback Called after state is updated.
   * @final
   * @protected
   */
  setState: function(partialState, callback) {
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof partialState === 'object' || partialState == null,
      'setState(...): takes an object of state variables to update.'
    ) : invariant(typeof partialState === 'object' || partialState == null));
    if ("production" !== process.env.NODE_ENV){
      ("production" !== process.env.NODE_ENV ? warning(
        partialState != null,
        'setState(...): You passed an undefined or null state object; ' +
        'instead, use forceUpdate().'
      ) : null);
    }
    // Merge with `_pendingState` if it exists, otherwise with existing state.
    this.replaceState(
      assign({}, this._pendingState || this.state, partialState),
      callback
    );
  },

  /**
   * Replaces all of the state. Always use this or `setState` to mutate state.
   * You should treat `this.state` as immutable.
   *
   * There is no guarantee that `this.state` will be immediately updated, so
   * accessing `this.state` after calling this method may return the old value.
   *
   * @param {object} completeState Next state.
   * @param {?function} callback Called after state is updated.
   * @final
   * @protected
   */
  replaceState: function(completeState, callback) {
    validateLifeCycleOnReplaceState(this);
    this._pendingState = completeState;
    if (this._compositeLifeCycleState !== CompositeLifeCycle.MOUNTING) {
      // If we're in a componentWillMount handler, don't enqueue a rerender
      // because ReactUpdates assumes we're in a browser context (which is wrong
      // for server rendering) and we're about to do a render anyway.
      // TODO: The callback here is ignored when setState is called from
      // componentWillMount. Either fix it or disallow doing so completely in
      // favor of getInitialState.
      ReactUpdates.enqueueUpdate(this, callback);
    }
  },

  /**
   * Filters the context object to only contain keys specified in
   * `contextTypes`, and asserts that they are valid.
   *
   * @param {object} context
   * @return {?object}
   * @private
   */
  _processContext: function(context) {
    var maskedContext = null;
    var contextTypes = this.constructor.contextTypes;
    if (contextTypes) {
      maskedContext = {};
      for (var contextName in contextTypes) {
        maskedContext[contextName] = context[contextName];
      }
      if ("production" !== process.env.NODE_ENV) {
        this._checkPropTypes(
          contextTypes,
          maskedContext,
          ReactPropTypeLocations.context
        );
      }
    }
    return maskedContext;
  },

  /**
   * @param {object} currentContext
   * @return {object}
   * @private
   */
  _processChildContext: function(currentContext) {
    var childContext = this.getChildContext && this.getChildContext();
    var displayName = this.constructor.displayName || 'ReactCompositeComponent';
    if (childContext) {
      ("production" !== process.env.NODE_ENV ? invariant(
        typeof this.constructor.childContextTypes === 'object',
        '%s.getChildContext(): childContextTypes must be defined in order to ' +
        'use getChildContext().',
        displayName
      ) : invariant(typeof this.constructor.childContextTypes === 'object'));
      if ("production" !== process.env.NODE_ENV) {
        this._checkPropTypes(
          this.constructor.childContextTypes,
          childContext,
          ReactPropTypeLocations.childContext
        );
      }
      for (var name in childContext) {
        ("production" !== process.env.NODE_ENV ? invariant(
          name in this.constructor.childContextTypes,
          '%s.getChildContext(): key "%s" is not defined in childContextTypes.',
          displayName,
          name
        ) : invariant(name in this.constructor.childContextTypes));
      }
      return assign({}, currentContext, childContext);
    }
    return currentContext;
  },

  /**
   * Processes props by setting default values for unspecified props and
   * asserting that the props are valid. Does not mutate its argument; returns
   * a new props object with defaults merged in.
   *
   * @param {object} newProps
   * @return {object}
   * @private
   */
  _processProps: function(newProps) {
    if ("production" !== process.env.NODE_ENV) {
      var propTypes = this.constructor.propTypes;
      if (propTypes) {
        this._checkPropTypes(propTypes, newProps, ReactPropTypeLocations.prop);
      }
    }
    return newProps;
  },

  /**
   * Assert that the props are valid
   *
   * @param {object} propTypes Map of prop name to a ReactPropType
   * @param {object} props
   * @param {string} location e.g. "prop", "context", "child context"
   * @private
   */
  _checkPropTypes: function(propTypes, props, location) {
    // TODO: Stop validating prop types here and only use the element
    // validation.
    var componentName = this.constructor.displayName;
    for (var propName in propTypes) {
      if (propTypes.hasOwnProperty(propName)) {
        var error =
          propTypes[propName](props, propName, componentName, location);
        if (error instanceof Error) {
          // We may want to extend this logic for similar errors in
          // renderComponent calls, so I'm abstracting it away into
          // a function to minimize refactoring in the future
          var addendum = getDeclarationErrorAddendum(this);
          ("production" !== process.env.NODE_ENV ? warning(false, error.message + addendum) : null);
        }
      }
    }
  },

  /**
   * If any of `_pendingElement`, `_pendingState`, or `_pendingForceUpdate`
   * is set, update the component.
   *
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
  performUpdateIfNecessary: function(transaction) {
    var compositeLifeCycleState = this._compositeLifeCycleState;
    // Do not trigger a state transition if we are in the middle of mounting or
    // receiving props because both of those will already be doing this.
    if (compositeLifeCycleState === CompositeLifeCycle.MOUNTING ||
        compositeLifeCycleState === CompositeLifeCycle.RECEIVING_PROPS) {
      return;
    }

    if (this._pendingElement == null &&
        this._pendingState == null &&
        !this._pendingForceUpdate) {
      return;
    }

    var nextContext = this.context;
    var nextProps = this.props;
    var nextElement = this._currentElement;
    if (this._pendingElement != null) {
      nextElement = this._pendingElement;
      nextContext = this._processContext(nextElement._context);
      nextProps = this._processProps(nextElement.props);
      this._pendingElement = null;

      this._compositeLifeCycleState = CompositeLifeCycle.RECEIVING_PROPS;
      if (this.componentWillReceiveProps) {
        this.componentWillReceiveProps(nextProps, nextContext);
      }
    }

    this._compositeLifeCycleState = null;

    var nextState = this._pendingState || this.state;
    this._pendingState = null;

    var shouldUpdate =
      this._pendingForceUpdate ||
      !this.shouldComponentUpdate ||
      this.shouldComponentUpdate(nextProps, nextState, nextContext);

    if ("production" !== process.env.NODE_ENV) {
      if (typeof shouldUpdate === "undefined") {
        console.warn(
          (this.constructor.displayName || 'ReactCompositeComponent') +
          '.shouldComponentUpdate(): Returned undefined instead of a ' +
          'boolean value. Make sure to return true or false.'
        );
      }
    }

    if (shouldUpdate) {
      this._pendingForceUpdate = false;
      // Will set `this.props`, `this.state` and `this.context`.
      this._performComponentUpdate(
        nextElement,
        nextProps,
        nextState,
        nextContext,
        transaction
      );
    } else {
      // If it's determined that a component should not update, we still want
      // to set props and state.
      this._currentElement = nextElement;
      this.props = nextProps;
      this.state = nextState;
      this.context = nextContext;

      // Owner cannot change because shouldUpdateReactComponent doesn't allow
      // it. TODO: Remove this._owner completely.
      this._owner = nextElement._owner;
    }
  },

  /**
   * Merges new props and state, notifies delegate methods of update and
   * performs update.
   *
   * @param {ReactElement} nextElement Next element
   * @param {object} nextProps Next public object to set as properties.
   * @param {?object} nextState Next object to set as state.
   * @param {?object} nextContext Next public object to set as context.
   * @param {ReactReconcileTransaction} transaction
   * @private
   */
  _performComponentUpdate: function(
    nextElement,
    nextProps,
    nextState,
    nextContext,
    transaction
  ) {
    var prevElement = this._currentElement;
    var prevProps = this.props;
    var prevState = this.state;
    var prevContext = this.context;

    if (this.componentWillUpdate) {
      this.componentWillUpdate(nextProps, nextState, nextContext);
    }

    this._currentElement = nextElement;
    this.props = nextProps;
    this.state = nextState;
    this.context = nextContext;

    // Owner cannot change because shouldUpdateReactComponent doesn't allow
    // it. TODO: Remove this._owner completely.
    this._owner = nextElement._owner;

    this.updateComponent(
      transaction,
      prevElement
    );

    if (this.componentDidUpdate) {
      transaction.getReactMountReady().enqueue(
        this.componentDidUpdate.bind(this, prevProps, prevState, prevContext),
        this
      );
    }
  },

  receiveComponent: function(nextElement, transaction) {
    if (nextElement === this._currentElement &&
        nextElement._owner != null) {
      // Since elements are immutable after the owner is rendered,
      // we can do a cheap identity compare here to determine if this is a
      // superfluous reconcile. It's possible for state to be mutable but such
      // change should trigger an update of the owner which would recreate
      // the element. We explicitly check for the existence of an owner since
      // it's possible for a element created outside a composite to be
      // deeply mutated and reused.
      return;
    }

    ReactComponent.Mixin.receiveComponent.call(
      this,
      nextElement,
      transaction
    );
  },

  /**
   * Updates the component's currently mounted DOM representation.
   *
   * By default, this implements React's rendering and reconciliation algorithm.
   * Sophisticated clients may wish to override this.
   *
   * @param {ReactReconcileTransaction} transaction
   * @param {ReactElement} prevElement
   * @internal
   * @overridable
   */
  updateComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    'updateComponent',
    function(transaction, prevParentElement) {
      ReactComponent.Mixin.updateComponent.call(
        this,
        transaction,
        prevParentElement
      );

      var prevComponentInstance = this._renderedComponent;
      var prevElement = prevComponentInstance._currentElement;
      var nextElement = this._renderValidatedComponent();
      if (shouldUpdateReactComponent(prevElement, nextElement)) {
        prevComponentInstance.receiveComponent(nextElement, transaction);
      } else {
        // These two IDs are actually the same! But nothing should rely on that.
        var thisID = this._rootNodeID;
        var prevComponentID = prevComponentInstance._rootNodeID;
        prevComponentInstance.unmountComponent();
        this._renderedComponent = instantiateReactComponent(
          nextElement,
          this._currentElement.type
        );
        var nextMarkup = this._renderedComponent.mountComponent(
          thisID,
          transaction,
          this._mountDepth + 1
        );
        ReactComponent.BackendIDOperations.dangerouslyReplaceNodeWithMarkupByID(
          prevComponentID,
          nextMarkup
        );
      }
    }
  ),

  /**
   * Forces an update. This should only be invoked when it is known with
   * certainty that we are **not** in a DOM transaction.
   *
   * You may want to call this when you know that some deeper aspect of the
   * component's state has changed but `setState` was not called.
   *
   * This will not invoke `shouldUpdateComponent`, but it will invoke
   * `componentWillUpdate` and `componentDidUpdate`.
   *
   * @param {?function} callback Called after update is complete.
   * @final
   * @protected
   */
  forceUpdate: function(callback) {
    var compositeLifeCycleState = this._compositeLifeCycleState;
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isMounted() ||
        compositeLifeCycleState === CompositeLifeCycle.MOUNTING,
      'forceUpdate(...): Can only force an update on mounted or mounting ' +
        'components.'
    ) : invariant(this.isMounted() ||
      compositeLifeCycleState === CompositeLifeCycle.MOUNTING));
    ("production" !== process.env.NODE_ENV ? invariant(
      compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING &&
      ReactCurrentOwner.current == null,
      'forceUpdate(...): Cannot force an update while unmounting component ' +
      'or within a `render` function.'
    ) : invariant(compositeLifeCycleState !== CompositeLifeCycle.UNMOUNTING &&
    ReactCurrentOwner.current == null));
    this._pendingForceUpdate = true;
    ReactUpdates.enqueueUpdate(this, callback);
  },

  /**
   * @private
   */
  _renderValidatedComponent: ReactPerf.measure(
    'ReactCompositeComponent',
    '_renderValidatedComponent',
    function() {
      var renderedComponent;
      var previousContext = ReactContext.current;
      ReactContext.current = this._processChildContext(
        this._currentElement._context
      );
      ReactCurrentOwner.current = this;
      try {
        renderedComponent = this.render();
        if (renderedComponent === null || renderedComponent === false) {
          renderedComponent = ReactEmptyComponent.getEmptyComponent();
          ReactEmptyComponent.registerNullComponentID(this._rootNodeID);
        } else {
          ReactEmptyComponent.deregisterNullComponentID(this._rootNodeID);
        }
      } finally {
        ReactContext.current = previousContext;
        ReactCurrentOwner.current = null;
      }
      ("production" !== process.env.NODE_ENV ? invariant(
        ReactElement.isValidElement(renderedComponent),
        '%s.render(): A valid ReactComponent must be returned. You may have ' +
          'returned undefined, an array or some other invalid object.',
        this.constructor.displayName || 'ReactCompositeComponent'
      ) : invariant(ReactElement.isValidElement(renderedComponent)));
      return renderedComponent;
    }
  ),

  /**
   * @private
   */
  _bindAutoBindMethods: function() {
    for (var autoBindKey in this.__reactAutoBindMap) {
      if (!this.__reactAutoBindMap.hasOwnProperty(autoBindKey)) {
        continue;
      }
      var method = this.__reactAutoBindMap[autoBindKey];
      this[autoBindKey] = this._bindAutoBindMethod(ReactErrorUtils.guard(
        method,
        this.constructor.displayName + '.' + autoBindKey
      ));
    }
  },

  /**
   * Binds a method to the component.
   *
   * @param {function} method Method to be bound.
   * @private
   */
  _bindAutoBindMethod: function(method) {
    var component = this;
    var boundMethod = method.bind(component);
    if ("production" !== process.env.NODE_ENV) {
      boundMethod.__reactBoundContext = component;
      boundMethod.__reactBoundMethod = method;
      boundMethod.__reactBoundArguments = null;
      var componentName = component.constructor.displayName;
      var _bind = boundMethod.bind;
      boundMethod.bind = function(newThis ) {for (var args=[],$__0=1,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
        // User is trying to bind() an autobound method; we effectively will
        // ignore the value of "this" that the user is trying to use, so
        // let's warn.
        if (newThis !== component && newThis !== null) {
          monitorCodeUse('react_bind_warning', { component: componentName });
          console.warn(
            'bind(): React component methods may only be bound to the ' +
            'component instance. See ' + componentName
          );
        } else if (!args.length) {
          monitorCodeUse('react_bind_warning', { component: componentName });
          console.warn(
            'bind(): You are binding a component method to the component. ' +
            'React does this for you automatically in a high-performance ' +
            'way, so you can safely remove this call. See ' + componentName
          );
          return boundMethod;
        }
        var reboundMethod = _bind.apply(boundMethod, arguments);
        reboundMethod.__reactBoundContext = component;
        reboundMethod.__reactBoundMethod = method;
        reboundMethod.__reactBoundArguments = args;
        return reboundMethod;
      };
    }
    return boundMethod;
  }
};

var ReactCompositeComponentBase = function() {};
assign(
  ReactCompositeComponentBase.prototype,
  ReactComponent.Mixin,
  ReactOwner.Mixin,
  ReactPropTransferer.Mixin,
  ReactCompositeComponentMixin
);

/**
 * Module for creating composite components.
 *
 * @class ReactCompositeComponent
 * @extends ReactComponent
 * @extends ReactOwner
 * @extends ReactPropTransferer
 */
var ReactCompositeComponent = {

  LifeCycle: CompositeLifeCycle,

  Base: ReactCompositeComponentBase,

  /**
   * Creates a composite component class given a class specification.
   *
   * @param {object} spec Class specification (which must define `render`).
   * @return {function} Component constructor function.
   * @public
   */
  createClass: function(spec) {
    var Constructor = function(props) {
      // This constructor is overridden by mocks. The argument is used
      // by mocks to assert on what gets mounted. This will later be used
      // by the stand-alone class implementation.
    };
    Constructor.prototype = new ReactCompositeComponentBase();
    Constructor.prototype.constructor = Constructor;

    injectedMixins.forEach(
      mixSpecIntoComponent.bind(null, Constructor)
    );

    mixSpecIntoComponent(Constructor, spec);

    // Initialize the defaultProps property after all mixins have been merged
    if (Constructor.getDefaultProps) {
      Constructor.defaultProps = Constructor.getDefaultProps();
    }

    ("production" !== process.env.NODE_ENV ? invariant(
      Constructor.prototype.render,
      'createClass(...): Class specification must implement a `render` method.'
    ) : invariant(Constructor.prototype.render));

    if ("production" !== process.env.NODE_ENV) {
      if (Constructor.prototype.componentShouldUpdate) {
        monitorCodeUse(
          'react_component_should_update_warning',
          { component: spec.displayName }
        );
        console.warn(
          (spec.displayName || 'A component') + ' has a method called ' +
          'componentShouldUpdate(). Did you mean shouldComponentUpdate()? ' +
          'The name is phrased as a question because the function is ' +
          'expected to return a value.'
         );
      }
    }

    // Reduce time spent doing lookups by setting these on the prototype.
    for (var methodName in ReactCompositeComponentInterface) {
      if (!Constructor.prototype[methodName]) {
        Constructor.prototype[methodName] = null;
      }
    }

    if ("production" !== process.env.NODE_ENV) {
      return ReactLegacyElement.wrapFactory(
        ReactElementValidator.createFactory(Constructor)
      );
    }
    return ReactLegacyElement.wrapFactory(
      ReactElement.createFactory(Constructor)
    );
  },

  injection: {
    injectMixin: function(mixin) {
      injectedMixins.push(mixin);
    }
  }
};

module.exports = ReactCompositeComponent;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./ReactComponent":32,"./ReactContext":35,"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactElementValidator":53,"./ReactEmptyComponent":54,"./ReactErrorUtils":55,"./ReactLegacyElement":61,"./ReactOwner":67,"./ReactPerf":68,"./ReactPropTransferer":69,"./ReactPropTypeLocationNames":70,"./ReactPropTypeLocations":71,"./ReactUpdates":79,"./instantiateReactComponent":125,"./invariant":126,"./keyMirror":132,"./keyOf":133,"./mapObject":134,"./monitorCodeUse":136,"./shouldUpdateReactComponent":142,"./warning":145,"ngpmcQ":176}],35:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactContext
 */

"use strict";

var assign = require("./Object.assign");

/**
 * Keeps track of the current context.
 *
 * The context is automatically passed down the component ownership hierarchy
 * and is accessible via `this.context` on ReactCompositeComponents.
 */
var ReactContext = {

  /**
   * @internal
   * @type {object}
   */
  current: {},

  /**
   * Temporarily extends the current context while executing scopedCallback.
   *
   * A typical use case might look like
   *
   *  render: function() {
   *    var children = ReactContext.withContext({foo: 'foo'}, () => (
   *
   *    ));
   *    return <div>{children}</div>;
   *  }
   *
   * @param {object} newContext New context to merge into the existing context
   * @param {function} scopedCallback Callback to run with the new context
   * @return {ReactComponent|array<ReactComponent>}
   */
  withContext: function(newContext, scopedCallback) {
    var result;
    var previousContext = ReactContext.current;
    ReactContext.current = assign({}, previousContext, newContext);
    try {
      result = scopedCallback();
    } finally {
      ReactContext.current = previousContext;
    }
    return result;
  }

};

module.exports = ReactContext;

},{"./Object.assign":26}],36:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactCurrentOwner
 */

"use strict";

/**
 * Keeps track of the current owner.
 *
 * The current owner is the component who should own any components that are
 * currently being constructed.
 *
 * The depth indicate how many composite components are above this render level.
 */
var ReactCurrentOwner = {

  /**
   * @internal
   * @type {ReactComponent}
   */
  current: null

};

module.exports = ReactCurrentOwner;

},{}],37:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOM
 * @typechecks static-only
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactElementValidator = require("./ReactElementValidator");
var ReactLegacyElement = require("./ReactLegacyElement");

var mapObject = require("./mapObject");

/**
 * Create a factory that creates HTML tag elements.
 *
 * @param {string} tag Tag name (e.g. `div`).
 * @private
 */
function createDOMFactory(tag) {
  if ("production" !== process.env.NODE_ENV) {
    return ReactLegacyElement.markNonLegacyFactory(
      ReactElementValidator.createFactory(tag)
    );
  }
  return ReactLegacyElement.markNonLegacyFactory(
    ReactElement.createFactory(tag)
  );
}

/**
 * Creates a mapping from supported HTML tags to `ReactDOMComponent` classes.
 * This is also accessible via `React.DOM`.
 *
 * @public
 */
var ReactDOM = mapObject({
  a: 'a',
  abbr: 'abbr',
  address: 'address',
  area: 'area',
  article: 'article',
  aside: 'aside',
  audio: 'audio',
  b: 'b',
  base: 'base',
  bdi: 'bdi',
  bdo: 'bdo',
  big: 'big',
  blockquote: 'blockquote',
  body: 'body',
  br: 'br',
  button: 'button',
  canvas: 'canvas',
  caption: 'caption',
  cite: 'cite',
  code: 'code',
  col: 'col',
  colgroup: 'colgroup',
  data: 'data',
  datalist: 'datalist',
  dd: 'dd',
  del: 'del',
  details: 'details',
  dfn: 'dfn',
  dialog: 'dialog',
  div: 'div',
  dl: 'dl',
  dt: 'dt',
  em: 'em',
  embed: 'embed',
  fieldset: 'fieldset',
  figcaption: 'figcaption',
  figure: 'figure',
  footer: 'footer',
  form: 'form',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  head: 'head',
  header: 'header',
  hr: 'hr',
  html: 'html',
  i: 'i',
  iframe: 'iframe',
  img: 'img',
  input: 'input',
  ins: 'ins',
  kbd: 'kbd',
  keygen: 'keygen',
  label: 'label',
  legend: 'legend',
  li: 'li',
  link: 'link',
  main: 'main',
  map: 'map',
  mark: 'mark',
  menu: 'menu',
  menuitem: 'menuitem',
  meta: 'meta',
  meter: 'meter',
  nav: 'nav',
  noscript: 'noscript',
  object: 'object',
  ol: 'ol',
  optgroup: 'optgroup',
  option: 'option',
  output: 'output',
  p: 'p',
  param: 'param',
  picture: 'picture',
  pre: 'pre',
  progress: 'progress',
  q: 'q',
  rp: 'rp',
  rt: 'rt',
  ruby: 'ruby',
  s: 's',
  samp: 'samp',
  script: 'script',
  section: 'section',
  select: 'select',
  small: 'small',
  source: 'source',
  span: 'span',
  strong: 'strong',
  style: 'style',
  sub: 'sub',
  summary: 'summary',
  sup: 'sup',
  table: 'table',
  tbody: 'tbody',
  td: 'td',
  textarea: 'textarea',
  tfoot: 'tfoot',
  th: 'th',
  thead: 'thead',
  time: 'time',
  title: 'title',
  tr: 'tr',
  track: 'track',
  u: 'u',
  ul: 'ul',
  'var': 'var',
  video: 'video',
  wbr: 'wbr',

  // SVG
  circle: 'circle',
  defs: 'defs',
  ellipse: 'ellipse',
  g: 'g',
  line: 'line',
  linearGradient: 'linearGradient',
  mask: 'mask',
  path: 'path',
  pattern: 'pattern',
  polygon: 'polygon',
  polyline: 'polyline',
  radialGradient: 'radialGradient',
  rect: 'rect',
  stop: 'stop',
  svg: 'svg',
  text: 'text',
  tspan: 'tspan'

}, createDOMFactory);

module.exports = ReactDOM;

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./ReactElementValidator":53,"./ReactLegacyElement":61,"./mapObject":134,"ngpmcQ":176}],38:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMButton
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

var keyMirror = require("./keyMirror");

// Store a reference to the <button> `ReactDOMComponent`. TODO: use string
var button = ReactElement.createFactory(ReactDOM.button.type);

var mouseListenerNames = keyMirror({
  onClick: true,
  onDoubleClick: true,
  onMouseDown: true,
  onMouseMove: true,
  onMouseUp: true,
  onClickCapture: true,
  onDoubleClickCapture: true,
  onMouseDownCapture: true,
  onMouseMoveCapture: true,
  onMouseUpCapture: true
});

/**
 * Implements a <button> native component that does not receive mouse events
 * when `disabled` is set.
 */
var ReactDOMButton = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMButton',

  mixins: [AutoFocusMixin, ReactBrowserComponentMixin],

  render: function() {
    var props = {};

    // Copy the props; except the mouse listeners if we're disabled
    for (var key in this.props) {
      if (this.props.hasOwnProperty(key) &&
          (!this.props.disabled || !mouseListenerNames[key])) {
        props[key] = this.props[key];
      }
    }

    return button(props, this.props.children);
  }

});

module.exports = ReactDOMButton;

},{"./AutoFocusMixin":1,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./keyMirror":132}],39:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMComponent
 * @typechecks static-only
 */

"use strict";

var CSSPropertyOperations = require("./CSSPropertyOperations");
var DOMProperty = require("./DOMProperty");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactComponent = require("./ReactComponent");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactMount = require("./ReactMount");
var ReactMultiChild = require("./ReactMultiChild");
var ReactPerf = require("./ReactPerf");

var assign = require("./Object.assign");
var escapeTextForBrowser = require("./escapeTextForBrowser");
var invariant = require("./invariant");
var isEventSupported = require("./isEventSupported");
var keyOf = require("./keyOf");
var monitorCodeUse = require("./monitorCodeUse");

var deleteListener = ReactBrowserEventEmitter.deleteListener;
var listenTo = ReactBrowserEventEmitter.listenTo;
var registrationNameModules = ReactBrowserEventEmitter.registrationNameModules;

// For quickly matching children type, to test if can be treated as content.
var CONTENT_TYPES = {'string': true, 'number': true};

var STYLE = keyOf({style: null});

var ELEMENT_NODE_TYPE = 1;

/**
 * @param {?object} props
 */
function assertValidProps(props) {
  if (!props) {
    return;
  }
  // Note the use of `==` which checks for null or undefined.
  ("production" !== process.env.NODE_ENV ? invariant(
    props.children == null || props.dangerouslySetInnerHTML == null,
    'Can only set one of `children` or `props.dangerouslySetInnerHTML`.'
  ) : invariant(props.children == null || props.dangerouslySetInnerHTML == null));
  if ("production" !== process.env.NODE_ENV) {
    if (props.contentEditable && props.children != null) {
      console.warn(
        'A component is `contentEditable` and contains `children` managed by ' +
        'React. It is now your responsibility to guarantee that none of those '+
        'nodes are unexpectedly modified or duplicated. This is probably not ' +
        'intentional.'
      );
    }
  }
  ("production" !== process.env.NODE_ENV ? invariant(
    props.style == null || typeof props.style === 'object',
    'The `style` prop expects a mapping from style properties to values, ' +
    'not a string.'
  ) : invariant(props.style == null || typeof props.style === 'object'));
}

function putListener(id, registrationName, listener, transaction) {
  if ("production" !== process.env.NODE_ENV) {
    // IE8 has no API for event capturing and the `onScroll` event doesn't
    // bubble.
    if (registrationName === 'onScroll' &&
        !isEventSupported('scroll', true)) {
      monitorCodeUse('react_no_scroll_event');
      console.warn('This browser doesn\'t support the `onScroll` event');
    }
  }
  var container = ReactMount.findReactContainerForID(id);
  if (container) {
    var doc = container.nodeType === ELEMENT_NODE_TYPE ?
      container.ownerDocument :
      container;
    listenTo(registrationName, doc);
  }
  transaction.getPutListenerQueue().enqueuePutListener(
    id,
    registrationName,
    listener
  );
}

// For HTML, certain tags should omit their close tag. We keep a whitelist for
// those special cased tags.

var omittedCloseTags = {
  'area': true,
  'base': true,
  'br': true,
  'col': true,
  'embed': true,
  'hr': true,
  'img': true,
  'input': true,
  'keygen': true,
  'link': true,
  'meta': true,
  'param': true,
  'source': true,
  'track': true,
  'wbr': true
  // NOTE: menuitem's close tag should be omitted, but that causes problems.
};

// We accept any tag to be rendered but since this gets injected into abitrary
// HTML, we want to make sure that it's a safe tag.
// http://www.w3.org/TR/REC-xml/#NT-Name

var VALID_TAG_REGEX = /^[a-zA-Z][a-zA-Z:_\.\-\d]*$/; // Simplified subset
var validatedTagCache = {};
var hasOwnProperty = {}.hasOwnProperty;

function validateDangerousTag(tag) {
  if (!hasOwnProperty.call(validatedTagCache, tag)) {
    ("production" !== process.env.NODE_ENV ? invariant(VALID_TAG_REGEX.test(tag), 'Invalid tag: %s', tag) : invariant(VALID_TAG_REGEX.test(tag)));
    validatedTagCache[tag] = true;
  }
}

/**
 * Creates a new React class that is idempotent and capable of containing other
 * React components. It accepts event listeners and DOM properties that are
 * valid according to `DOMProperty`.
 *
 *  - Event listeners: `onClick`, `onMouseDown`, etc.
 *  - DOM properties: `className`, `name`, `title`, etc.
 *
 * The `style` property functions differently from the DOM API. It accepts an
 * object mapping of style properties to values.
 *
 * @constructor ReactDOMComponent
 * @extends ReactComponent
 * @extends ReactMultiChild
 */
function ReactDOMComponent(tag) {
  validateDangerousTag(tag);
  this._tag = tag;
  this.tagName = tag.toUpperCase();
}

ReactDOMComponent.displayName = 'ReactDOMComponent';

ReactDOMComponent.Mixin = {

  /**
   * Generates root tag markup then recurses. This method has side effects and
   * is not idempotent.
   *
   * @internal
   * @param {string} rootID The root DOM ID for this node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {string} The computed markup.
   */
  mountComponent: ReactPerf.measure(
    'ReactDOMComponent',
    'mountComponent',
    function(rootID, transaction, mountDepth) {
      ReactComponent.Mixin.mountComponent.call(
        this,
        rootID,
        transaction,
        mountDepth
      );
      assertValidProps(this.props);
      var closeTag = omittedCloseTags[this._tag] ? '' : '</' + this._tag + '>';
      return (
        this._createOpenTagMarkupAndPutListeners(transaction) +
        this._createContentMarkup(transaction) +
        closeTag
      );
    }
  ),

  /**
   * Creates markup for the open tag and all attributes.
   *
   * This method has side effects because events get registered.
   *
   * Iterating over object properties is faster than iterating over arrays.
   * @see http://jsperf.com/obj-vs-arr-iteration
   *
   * @private
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @return {string} Markup of opening tag.
   */
  _createOpenTagMarkupAndPutListeners: function(transaction) {
    var props = this.props;
    var ret = '<' + this._tag;

    for (var propKey in props) {
      if (!props.hasOwnProperty(propKey)) {
        continue;
      }
      var propValue = props[propKey];
      if (propValue == null) {
        continue;
      }
      if (registrationNameModules.hasOwnProperty(propKey)) {
        putListener(this._rootNodeID, propKey, propValue, transaction);
      } else {
        if (propKey === STYLE) {
          if (propValue) {
            propValue = props.style = assign({}, props.style);
          }
          propValue = CSSPropertyOperations.createMarkupForStyles(propValue);
        }
        var markup =
          DOMPropertyOperations.createMarkupForProperty(propKey, propValue);
        if (markup) {
          ret += ' ' + markup;
        }
      }
    }

    // For static pages, no need to put React ID and checksum. Saves lots of
    // bytes.
    if (transaction.renderToStaticMarkup) {
      return ret + '>';
    }

    var markupForID = DOMPropertyOperations.createMarkupForID(this._rootNodeID);
    return ret + ' ' + markupForID + '>';
  },

  /**
   * Creates markup for the content between the tags.
   *
   * @private
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @return {string} Content markup.
   */
  _createContentMarkup: function(transaction) {
    // Intentional use of != to avoid catching zero/false.
    var innerHTML = this.props.dangerouslySetInnerHTML;
    if (innerHTML != null) {
      if (innerHTML.__html != null) {
        return innerHTML.__html;
      }
    } else {
      var contentToUse =
        CONTENT_TYPES[typeof this.props.children] ? this.props.children : null;
      var childrenToUse = contentToUse != null ? null : this.props.children;
      if (contentToUse != null) {
        return escapeTextForBrowser(contentToUse);
      } else if (childrenToUse != null) {
        var mountImages = this.mountChildren(
          childrenToUse,
          transaction
        );
        return mountImages.join('');
      }
    }
    return '';
  },

  receiveComponent: function(nextElement, transaction) {
    if (nextElement === this._currentElement &&
        nextElement._owner != null) {
      // Since elements are immutable after the owner is rendered,
      // we can do a cheap identity compare here to determine if this is a
      // superfluous reconcile. It's possible for state to be mutable but such
      // change should trigger an update of the owner which would recreate
      // the element. We explicitly check for the existence of an owner since
      // it's possible for a element created outside a composite to be
      // deeply mutated and reused.
      return;
    }

    ReactComponent.Mixin.receiveComponent.call(
      this,
      nextElement,
      transaction
    );
  },

  /**
   * Updates a native DOM component after it has already been allocated and
   * attached to the DOM. Reconciles the root DOM node, then recurses.
   *
   * @param {ReactReconcileTransaction} transaction
   * @param {ReactElement} prevElement
   * @internal
   * @overridable
   */
  updateComponent: ReactPerf.measure(
    'ReactDOMComponent',
    'updateComponent',
    function(transaction, prevElement) {
      assertValidProps(this._currentElement.props);
      ReactComponent.Mixin.updateComponent.call(
        this,
        transaction,
        prevElement
      );
      this._updateDOMProperties(prevElement.props, transaction);
      this._updateDOMChildren(prevElement.props, transaction);
    }
  ),

  /**
   * Reconciles the properties by detecting differences in property values and
   * updating the DOM as necessary. This function is probably the single most
   * critical path for performance optimization.
   *
   * TODO: Benchmark whether checking for changed values in memory actually
   *       improves performance (especially statically positioned elements).
   * TODO: Benchmark the effects of putting this at the top since 99% of props
   *       do not change for a given reconciliation.
   * TODO: Benchmark areas that can be improved with caching.
   *
   * @private
   * @param {object} lastProps
   * @param {ReactReconcileTransaction} transaction
   */
  _updateDOMProperties: function(lastProps, transaction) {
    var nextProps = this.props;
    var propKey;
    var styleName;
    var styleUpdates;
    for (propKey in lastProps) {
      if (nextProps.hasOwnProperty(propKey) ||
         !lastProps.hasOwnProperty(propKey)) {
        continue;
      }
      if (propKey === STYLE) {
        var lastStyle = lastProps[propKey];
        for (styleName in lastStyle) {
          if (lastStyle.hasOwnProperty(styleName)) {
            styleUpdates = styleUpdates || {};
            styleUpdates[styleName] = '';
          }
        }
      } else if (registrationNameModules.hasOwnProperty(propKey)) {
        deleteListener(this._rootNodeID, propKey);
      } else if (
          DOMProperty.isStandardName[propKey] ||
          DOMProperty.isCustomAttribute(propKey)) {
        ReactComponent.BackendIDOperations.deletePropertyByID(
          this._rootNodeID,
          propKey
        );
      }
    }
    for (propKey in nextProps) {
      var nextProp = nextProps[propKey];
      var lastProp = lastProps[propKey];
      if (!nextProps.hasOwnProperty(propKey) || nextProp === lastProp) {
        continue;
      }
      if (propKey === STYLE) {
        if (nextProp) {
          nextProp = nextProps.style = assign({}, nextProp);
        }
        if (lastProp) {
          // Unset styles on `lastProp` but not on `nextProp`.
          for (styleName in lastProp) {
            if (lastProp.hasOwnProperty(styleName) &&
                (!nextProp || !nextProp.hasOwnProperty(styleName))) {
              styleUpdates = styleUpdates || {};
              styleUpdates[styleName] = '';
            }
          }
          // Update styles that changed since `lastProp`.
          for (styleName in nextProp) {
            if (nextProp.hasOwnProperty(styleName) &&
                lastProp[styleName] !== nextProp[styleName]) {
              styleUpdates = styleUpdates || {};
              styleUpdates[styleName] = nextProp[styleName];
            }
          }
        } else {
          // Relies on `updateStylesByID` not mutating `styleUpdates`.
          styleUpdates = nextProp;
        }
      } else if (registrationNameModules.hasOwnProperty(propKey)) {
        putListener(this._rootNodeID, propKey, nextProp, transaction);
      } else if (
          DOMProperty.isStandardName[propKey] ||
          DOMProperty.isCustomAttribute(propKey)) {
        ReactComponent.BackendIDOperations.updatePropertyByID(
          this._rootNodeID,
          propKey,
          nextProp
        );
      }
    }
    if (styleUpdates) {
      ReactComponent.BackendIDOperations.updateStylesByID(
        this._rootNodeID,
        styleUpdates
      );
    }
  },

  /**
   * Reconciles the children with the various properties that affect the
   * children content.
   *
   * @param {object} lastProps
   * @param {ReactReconcileTransaction} transaction
   */
  _updateDOMChildren: function(lastProps, transaction) {
    var nextProps = this.props;

    var lastContent =
      CONTENT_TYPES[typeof lastProps.children] ? lastProps.children : null;
    var nextContent =
      CONTENT_TYPES[typeof nextProps.children] ? nextProps.children : null;

    var lastHtml =
      lastProps.dangerouslySetInnerHTML &&
      lastProps.dangerouslySetInnerHTML.__html;
    var nextHtml =
      nextProps.dangerouslySetInnerHTML &&
      nextProps.dangerouslySetInnerHTML.__html;

    // Note the use of `!=` which checks for null or undefined.
    var lastChildren = lastContent != null ? null : lastProps.children;
    var nextChildren = nextContent != null ? null : nextProps.children;

    // If we're switching from children to content/html or vice versa, remove
    // the old content
    var lastHasContentOrHtml = lastContent != null || lastHtml != null;
    var nextHasContentOrHtml = nextContent != null || nextHtml != null;
    if (lastChildren != null && nextChildren == null) {
      this.updateChildren(null, transaction);
    } else if (lastHasContentOrHtml && !nextHasContentOrHtml) {
      this.updateTextContent('');
    }

    if (nextContent != null) {
      if (lastContent !== nextContent) {
        this.updateTextContent('' + nextContent);
      }
    } else if (nextHtml != null) {
      if (lastHtml !== nextHtml) {
        ReactComponent.BackendIDOperations.updateInnerHTMLByID(
          this._rootNodeID,
          nextHtml
        );
      }
    } else if (nextChildren != null) {
      this.updateChildren(nextChildren, transaction);
    }
  },

  /**
   * Destroys all event registrations for this instance. Does not remove from
   * the DOM. That must be done by the parent.
   *
   * @internal
   */
  unmountComponent: function() {
    this.unmountChildren();
    ReactBrowserEventEmitter.deleteAllListeners(this._rootNodeID);
    ReactComponent.Mixin.unmountComponent.call(this);
  }

};

assign(
  ReactDOMComponent.prototype,
  ReactComponent.Mixin,
  ReactDOMComponent.Mixin,
  ReactMultiChild.Mixin,
  ReactBrowserComponentMixin
);

module.exports = ReactDOMComponent;

}).call(this,require("ngpmcQ"))
},{"./CSSPropertyOperations":4,"./DOMProperty":10,"./DOMPropertyOperations":11,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactBrowserEventEmitter":30,"./ReactComponent":32,"./ReactMount":63,"./ReactMultiChild":64,"./ReactPerf":68,"./escapeTextForBrowser":109,"./invariant":126,"./isEventSupported":127,"./keyOf":133,"./monitorCodeUse":136,"ngpmcQ":176}],40:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMForm
 */

"use strict";

var EventConstants = require("./EventConstants");
var LocalEventTrapMixin = require("./LocalEventTrapMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

// Store a reference to the <form> `ReactDOMComponent`. TODO: use string
var form = ReactElement.createFactory(ReactDOM.form.type);

/**
 * Since onSubmit doesn't bubble OR capture on the top level in IE8, we need
 * to capture it on the <form> element itself. There are lots of hacks we could
 * do to accomplish this, but the most reliable is to make <form> a
 * composite component and use `componentDidMount` to attach the event handlers.
 */
var ReactDOMForm = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMForm',

  mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],

  render: function() {
    // TODO: Instead of using `ReactDOM` directly, we should use JSX. However,
    // `jshint` fails to parse JSX so in order for linting to work in the open
    // source repo, we need to just use `ReactDOM.form`.
    return form(this.props);
  },

  componentDidMount: function() {
    this.trapBubbledEvent(EventConstants.topLevelTypes.topReset, 'reset');
    this.trapBubbledEvent(EventConstants.topLevelTypes.topSubmit, 'submit');
  }
});

module.exports = ReactDOMForm;

},{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52}],41:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMIDOperations
 * @typechecks static-only
 */

/*jslint evil: true */

"use strict";

var CSSPropertyOperations = require("./CSSPropertyOperations");
var DOMChildrenOperations = require("./DOMChildrenOperations");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");

var invariant = require("./invariant");
var setInnerHTML = require("./setInnerHTML");

/**
 * Errors for properties that should not be updated with `updatePropertyById()`.
 *
 * @type {object}
 * @private
 */
var INVALID_PROPERTY_ERRORS = {
  dangerouslySetInnerHTML:
    '`dangerouslySetInnerHTML` must be set using `updateInnerHTMLByID()`.',
  style: '`style` must be set using `updateStylesByID()`.'
};

/**
 * Operations used to process updates to DOM nodes. This is made injectable via
 * `ReactComponent.BackendIDOperations`.
 */
var ReactDOMIDOperations = {

  /**
   * Updates a DOM node with new property values. This should only be used to
   * update DOM properties in `DOMProperty`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} name A valid property name, see `DOMProperty`.
   * @param {*} value New value of the property.
   * @internal
   */
  updatePropertyByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updatePropertyByID',
    function(id, name, value) {
      var node = ReactMount.getNode(id);
      ("production" !== process.env.NODE_ENV ? invariant(
        !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
        'updatePropertyByID(...): %s',
        INVALID_PROPERTY_ERRORS[name]
      ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));

      // If we're updating to null or undefined, we should remove the property
      // from the DOM node instead of inadvertantly setting to a string. This
      // brings us in line with the same behavior we have on initial render.
      if (value != null) {
        DOMPropertyOperations.setValueForProperty(node, name, value);
      } else {
        DOMPropertyOperations.deleteValueForProperty(node, name);
      }
    }
  ),

  /**
   * Updates a DOM node to remove a property. This should only be used to remove
   * DOM properties in `DOMProperty`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} name A property name to remove, see `DOMProperty`.
   * @internal
   */
  deletePropertyByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'deletePropertyByID',
    function(id, name, value) {
      var node = ReactMount.getNode(id);
      ("production" !== process.env.NODE_ENV ? invariant(
        !INVALID_PROPERTY_ERRORS.hasOwnProperty(name),
        'updatePropertyByID(...): %s',
        INVALID_PROPERTY_ERRORS[name]
      ) : invariant(!INVALID_PROPERTY_ERRORS.hasOwnProperty(name)));
      DOMPropertyOperations.deleteValueForProperty(node, name, value);
    }
  ),

  /**
   * Updates a DOM node with new style values. If a value is specified as '',
   * the corresponding style property will be unset.
   *
   * @param {string} id ID of the node to update.
   * @param {object} styles Mapping from styles to values.
   * @internal
   */
  updateStylesByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateStylesByID',
    function(id, styles) {
      var node = ReactMount.getNode(id);
      CSSPropertyOperations.setValueForStyles(node, styles);
    }
  ),

  /**
   * Updates a DOM node's innerHTML.
   *
   * @param {string} id ID of the node to update.
   * @param {string} html An HTML string.
   * @internal
   */
  updateInnerHTMLByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateInnerHTMLByID',
    function(id, html) {
      var node = ReactMount.getNode(id);
      setInnerHTML(node, html);
    }
  ),

  /**
   * Updates a DOM node's text content set by `props.content`.
   *
   * @param {string} id ID of the node to update.
   * @param {string} content Text content.
   * @internal
   */
  updateTextContentByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'updateTextContentByID',
    function(id, content) {
      var node = ReactMount.getNode(id);
      DOMChildrenOperations.updateTextContent(node, content);
    }
  ),

  /**
   * Replaces a DOM node that exists in the document with markup.
   *
   * @param {string} id ID of child to be replaced.
   * @param {string} markup Dangerous markup to inject in place of child.
   * @internal
   * @see {Danger.dangerouslyReplaceNodeWithMarkup}
   */
  dangerouslyReplaceNodeWithMarkupByID: ReactPerf.measure(
    'ReactDOMIDOperations',
    'dangerouslyReplaceNodeWithMarkupByID',
    function(id, markup) {
      var node = ReactMount.getNode(id);
      DOMChildrenOperations.dangerouslyReplaceNodeWithMarkup(node, markup);
    }
  ),

  /**
   * Updates a component's children by processing a series of updates.
   *
   * @param {array<object>} updates List of update configurations.
   * @param {array<string>} markup List of markup strings.
   * @internal
   */
  dangerouslyProcessChildrenUpdates: ReactPerf.measure(
    'ReactDOMIDOperations',
    'dangerouslyProcessChildrenUpdates',
    function(updates, markup) {
      for (var i = 0; i < updates.length; i++) {
        updates[i].parentNode = ReactMount.getNode(updates[i].parentID);
      }
      DOMChildrenOperations.processUpdates(updates, markup);
    }
  )
};

module.exports = ReactDOMIDOperations;

}).call(this,require("ngpmcQ"))
},{"./CSSPropertyOperations":4,"./DOMChildrenOperations":9,"./DOMPropertyOperations":11,"./ReactMount":63,"./ReactPerf":68,"./invariant":126,"./setInnerHTML":140,"ngpmcQ":176}],42:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMImg
 */

"use strict";

var EventConstants = require("./EventConstants");
var LocalEventTrapMixin = require("./LocalEventTrapMixin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

// Store a reference to the <img> `ReactDOMComponent`. TODO: use string
var img = ReactElement.createFactory(ReactDOM.img.type);

/**
 * Since onLoad doesn't bubble OR capture on the top level in IE8, we need to
 * capture it on the <img> element itself. There are lots of hacks we could do
 * to accomplish this, but the most reliable is to make <img> a composite
 * component and use `componentDidMount` to attach the event handlers.
 */
var ReactDOMImg = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMImg',
  tagName: 'IMG',

  mixins: [ReactBrowserComponentMixin, LocalEventTrapMixin],

  render: function() {
    return img(this.props);
  },

  componentDidMount: function() {
    this.trapBubbledEvent(EventConstants.topLevelTypes.topLoad, 'load');
    this.trapBubbledEvent(EventConstants.topLevelTypes.topError, 'error');
  }
});

module.exports = ReactDOMImg;

},{"./EventConstants":15,"./LocalEventTrapMixin":24,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52}],43:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMInput
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactMount = require("./ReactMount");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");

// Store a reference to the <input> `ReactDOMComponent`. TODO: use string
var input = ReactElement.createFactory(ReactDOM.input.type);

var instancesByReactID = {};

function forceUpdateIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.forceUpdate();
  }
}

/**
 * Implements an <input> native component that allows setting these optional
 * props: `checked`, `value`, `defaultChecked`, and `defaultValue`.
 *
 * If `checked` or `value` are not supplied (or null/undefined), user actions
 * that affect the checked state or value will trigger updates to the element.
 *
 * If they are supplied (and not null/undefined), the rendered element will not
 * trigger updates to the element. Instead, the props must change in order for
 * the rendered element to be updated.
 *
 * The rendered element will be initialized as unchecked (or `defaultChecked`)
 * with an empty value (or `defaultValue`).
 *
 * @see http://www.w3.org/TR/2012/WD-html5-20121025/the-input-element.html
 */
var ReactDOMInput = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMInput',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  getInitialState: function() {
    var defaultValue = this.props.defaultValue;
    return {
      initialChecked: this.props.defaultChecked || false,
      initialValue: defaultValue != null ? defaultValue : null
    };
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    props.defaultChecked = null;
    props.defaultValue = null;

    var value = LinkedValueUtils.getValue(this);
    props.value = value != null ? value : this.state.initialValue;

    var checked = LinkedValueUtils.getChecked(this);
    props.checked = checked != null ? checked : this.state.initialChecked;

    props.onChange = this._handleChange;

    return input(props, this.props.children);
  },

  componentDidMount: function() {
    var id = ReactMount.getID(this.getDOMNode());
    instancesByReactID[id] = this;
  },

  componentWillUnmount: function() {
    var rootNode = this.getDOMNode();
    var id = ReactMount.getID(rootNode);
    delete instancesByReactID[id];
  },

  componentDidUpdate: function(prevProps, prevState, prevContext) {
    var rootNode = this.getDOMNode();
    if (this.props.checked != null) {
      DOMPropertyOperations.setValueForProperty(
        rootNode,
        'checked',
        this.props.checked || false
      );
    }

    var value = LinkedValueUtils.getValue(this);
    if (value != null) {
      // Cast `value` to a string to ensure the value is set correctly. While
      // browsers typically do this as necessary, jsdom doesn't.
      DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }
    // Here we use asap to wait until all updates have propagated, which
    // is important when using controlled components within layers:
    // https://github.com/facebook/react/issues/1698
    ReactUpdates.asap(forceUpdateIfMounted, this);

    var name = this.props.name;
    if (this.props.type === 'radio' && name != null) {
      var rootNode = this.getDOMNode();
      var queryRoot = rootNode;

      while (queryRoot.parentNode) {
        queryRoot = queryRoot.parentNode;
      }

      // If `rootNode.form` was non-null, then we could try `form.elements`,
      // but that sometimes behaves strangely in IE8. We could also try using
      // `form.getElementsByName`, but that will only return direct children
      // and won't include inputs that use the HTML5 `form=` attribute. Since
      // the input might not even be in a form, let's just use the global
      // `querySelectorAll` to ensure we don't miss anything.
      var group = queryRoot.querySelectorAll(
        'input[name=' + JSON.stringify('' + name) + '][type="radio"]');

      for (var i = 0, groupLen = group.length; i < groupLen; i++) {
        var otherNode = group[i];
        if (otherNode === rootNode ||
            otherNode.form !== rootNode.form) {
          continue;
        }
        var otherID = ReactMount.getID(otherNode);
        ("production" !== process.env.NODE_ENV ? invariant(
          otherID,
          'ReactDOMInput: Mixing React and non-React radio inputs with the ' +
          'same `name` is not supported.'
        ) : invariant(otherID));
        var otherInstance = instancesByReactID[otherID];
        ("production" !== process.env.NODE_ENV ? invariant(
          otherInstance,
          'ReactDOMInput: Unknown radio button ID %s.',
          otherID
        ) : invariant(otherInstance));
        // If this is a controlled radio button group, forcing the input that
        // was previously checked to update will cause it to be come re-checked
        // as appropriate.
        ReactUpdates.asap(forceUpdateIfMounted, otherInstance);
      }
    }

    return returnValue;
  }

});

module.exports = ReactDOMInput;

}).call(this,require("ngpmcQ"))
},{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactMount":63,"./ReactUpdates":79,"./invariant":126,"ngpmcQ":176}],44:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMOption
 */

"use strict";

var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");

var warning = require("./warning");

// Store a reference to the <option> `ReactDOMComponent`. TODO: use string
var option = ReactElement.createFactory(ReactDOM.option.type);

/**
 * Implements an <option> native component that warns when `selected` is set.
 */
var ReactDOMOption = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMOption',

  mixins: [ReactBrowserComponentMixin],

  componentWillMount: function() {
    // TODO (yungsters): Remove support for `selected` in <option>.
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? warning(
        this.props.selected == null,
        'Use the `defaultValue` or `value` props on <select> instead of ' +
        'setting `selected` on <option>.'
      ) : null);
    }
  },

  render: function() {
    return option(this.props, this.props.children);
  }

});

module.exports = ReactDOMOption;

}).call(this,require("ngpmcQ"))
},{"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./warning":145,"ngpmcQ":176}],45:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMSelect
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");

// Store a reference to the <select> `ReactDOMComponent`. TODO: use string
var select = ReactElement.createFactory(ReactDOM.select.type);

function updateWithPendingValueIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.setState({value: this._pendingValue});
    this._pendingValue = 0;
  }
}

/**
 * Validation function for `value` and `defaultValue`.
 * @private
 */
function selectValueType(props, propName, componentName) {
  if (props[propName] == null) {
    return;
  }
  if (props.multiple) {
    if (!Array.isArray(props[propName])) {
      return new Error(
        ("The `" + propName + "` prop supplied to <select> must be an array if ") +
        ("`multiple` is true.")
      );
    }
  } else {
    if (Array.isArray(props[propName])) {
      return new Error(
        ("The `" + propName + "` prop supplied to <select> must be a scalar ") +
        ("value if `multiple` is false.")
      );
    }
  }
}

/**
 * If `value` is supplied, updates <option> elements on mount and update.
 * @param {ReactComponent} component Instance of ReactDOMSelect
 * @param {?*} propValue For uncontrolled components, null/undefined. For
 * controlled components, a string (or with `multiple`, a list of strings).
 * @private
 */
function updateOptions(component, propValue) {
  var multiple = component.props.multiple;
  var value = propValue != null ? propValue : component.state.value;
  var options = component.getDOMNode().options;
  var selectedValue, i, l;
  if (multiple) {
    selectedValue = {};
    for (i = 0, l = value.length; i < l; ++i) {
      selectedValue['' + value[i]] = true;
    }
  } else {
    selectedValue = '' + value;
  }
  for (i = 0, l = options.length; i < l; i++) {
    var selected = multiple ?
      selectedValue.hasOwnProperty(options[i].value) :
      options[i].value === selectedValue;

    if (selected !== options[i].selected) {
      options[i].selected = selected;
    }
  }
}

/**
 * Implements a <select> native component that allows optionally setting the
 * props `value` and `defaultValue`. If `multiple` is false, the prop must be a
 * string. If `multiple` is true, the prop must be an array of strings.
 *
 * If `value` is not supplied (or null/undefined), user actions that change the
 * selected option will trigger updates to the rendered options.
 *
 * If it is supplied (and not null/undefined), the rendered options will not
 * update in response to user actions. Instead, the `value` prop must change in
 * order for the rendered options to update.
 *
 * If `defaultValue` is provided, any options with the supplied values will be
 * selected.
 */
var ReactDOMSelect = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMSelect',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  propTypes: {
    defaultValue: selectValueType,
    value: selectValueType
  },

  getInitialState: function() {
    return {value: this.props.defaultValue || (this.props.multiple ? [] : '')};
  },

  componentWillMount: function() {
    this._pendingValue = null;
  },

  componentWillReceiveProps: function(nextProps) {
    if (!this.props.multiple && nextProps.multiple) {
      this.setState({value: [this.state.value]});
    } else if (this.props.multiple && !nextProps.multiple) {
      this.setState({value: this.state.value[0]});
    }
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    props.onChange = this._handleChange;
    props.value = null;

    return select(props, this.props.children);
  },

  componentDidMount: function() {
    updateOptions(this, LinkedValueUtils.getValue(this));
  },

  componentDidUpdate: function(prevProps) {
    var value = LinkedValueUtils.getValue(this);
    var prevMultiple = !!prevProps.multiple;
    var multiple = !!this.props.multiple;
    if (value != null || prevMultiple !== multiple) {
      updateOptions(this, value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }

    var selectedValue;
    if (this.props.multiple) {
      selectedValue = [];
      var options = event.target.options;
      for (var i = 0, l = options.length; i < l; i++) {
        if (options[i].selected) {
          selectedValue.push(options[i].value);
        }
      }
    } else {
      selectedValue = event.target.value;
    }

    this._pendingValue = selectedValue;
    ReactUpdates.asap(updateWithPendingValueIfMounted, this);
    return returnValue;
  }

});

module.exports = ReactDOMSelect;

},{"./AutoFocusMixin":1,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactUpdates":79}],46:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMSelection
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var getNodeForCharacterOffset = require("./getNodeForCharacterOffset");
var getTextContentAccessor = require("./getTextContentAccessor");

/**
 * While `isCollapsed` is available on the Selection object and `collapsed`
 * is available on the Range object, IE11 sometimes gets them wrong.
 * If the anchor/focus nodes and offsets are the same, the range is collapsed.
 */
function isCollapsed(anchorNode, anchorOffset, focusNode, focusOffset) {
  return anchorNode === focusNode && anchorOffset === focusOffset;
}

/**
 * Get the appropriate anchor and focus node/offset pairs for IE.
 *
 * The catch here is that IE's selection API doesn't provide information
 * about whether the selection is forward or backward, so we have to
 * behave as though it's always forward.
 *
 * IE text differs from modern selection in that it behaves as though
 * block elements end with a new line. This means character offsets will
 * differ between the two APIs.
 *
 * @param {DOMElement} node
 * @return {object}
 */
function getIEOffsets(node) {
  var selection = document.selection;
  var selectedRange = selection.createRange();
  var selectedLength = selectedRange.text.length;

  // Duplicate selection so we can move range without breaking user selection.
  var fromStart = selectedRange.duplicate();
  fromStart.moveToElementText(node);
  fromStart.setEndPoint('EndToStart', selectedRange);

  var startOffset = fromStart.text.length;
  var endOffset = startOffset + selectedLength;

  return {
    start: startOffset,
    end: endOffset
  };
}

/**
 * @param {DOMElement} node
 * @return {?object}
 */
function getModernOffsets(node) {
  var selection = window.getSelection && window.getSelection();

  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  var anchorNode = selection.anchorNode;
  var anchorOffset = selection.anchorOffset;
  var focusNode = selection.focusNode;
  var focusOffset = selection.focusOffset;

  var currentRange = selection.getRangeAt(0);

  // If the node and offset values are the same, the selection is collapsed.
  // `Selection.isCollapsed` is available natively, but IE sometimes gets
  // this value wrong.
  var isSelectionCollapsed = isCollapsed(
    selection.anchorNode,
    selection.anchorOffset,
    selection.focusNode,
    selection.focusOffset
  );

  var rangeLength = isSelectionCollapsed ? 0 : currentRange.toString().length;

  var tempRange = currentRange.cloneRange();
  tempRange.selectNodeContents(node);
  tempRange.setEnd(currentRange.startContainer, currentRange.startOffset);

  var isTempRangeCollapsed = isCollapsed(
    tempRange.startContainer,
    tempRange.startOffset,
    tempRange.endContainer,
    tempRange.endOffset
  );

  var start = isTempRangeCollapsed ? 0 : tempRange.toString().length;
  var end = start + rangeLength;

  // Detect whether the selection is backward.
  var detectionRange = document.createRange();
  detectionRange.setStart(anchorNode, anchorOffset);
  detectionRange.setEnd(focusNode, focusOffset);
  var isBackward = detectionRange.collapsed;

  return {
    start: isBackward ? end : start,
    end: isBackward ? start : end
  };
}

/**
 * @param {DOMElement|DOMTextNode} node
 * @param {object} offsets
 */
function setIEOffsets(node, offsets) {
  var range = document.selection.createRange().duplicate();
  var start, end;

  if (typeof offsets.end === 'undefined') {
    start = offsets.start;
    end = start;
  } else if (offsets.start > offsets.end) {
    start = offsets.end;
    end = offsets.start;
  } else {
    start = offsets.start;
    end = offsets.end;
  }

  range.moveToElementText(node);
  range.moveStart('character', start);
  range.setEndPoint('EndToStart', range);
  range.moveEnd('character', end - start);
  range.select();
}

/**
 * In modern non-IE browsers, we can support both forward and backward
 * selections.
 *
 * Note: IE10+ supports the Selection object, but it does not support
 * the `extend` method, which means that even in modern IE, it's not possible
 * to programatically create a backward selection. Thus, for all IE
 * versions, we use the old IE API to create our selections.
 *
 * @param {DOMElement|DOMTextNode} node
 * @param {object} offsets
 */
function setModernOffsets(node, offsets) {
  if (!window.getSelection) {
    return;
  }

  var selection = window.getSelection();
  var length = node[getTextContentAccessor()].length;
  var start = Math.min(offsets.start, length);
  var end = typeof offsets.end === 'undefined' ?
            start : Math.min(offsets.end, length);

  // IE 11 uses modern selection, but doesn't support the extend method.
  // Flip backward selections, so we can set with a single range.
  if (!selection.extend && start > end) {
    var temp = end;
    end = start;
    start = temp;
  }

  var startMarker = getNodeForCharacterOffset(node, start);
  var endMarker = getNodeForCharacterOffset(node, end);

  if (startMarker && endMarker) {
    var range = document.createRange();
    range.setStart(startMarker.node, startMarker.offset);
    selection.removeAllRanges();

    if (start > end) {
      selection.addRange(range);
      selection.extend(endMarker.node, endMarker.offset);
    } else {
      range.setEnd(endMarker.node, endMarker.offset);
      selection.addRange(range);
    }
  }
}

var useIEOffsets = ExecutionEnvironment.canUseDOM && document.selection;

var ReactDOMSelection = {
  /**
   * @param {DOMElement} node
   */
  getOffsets: useIEOffsets ? getIEOffsets : getModernOffsets,

  /**
   * @param {DOMElement|DOMTextNode} node
   * @param {object} offsets
   */
  setOffsets: useIEOffsets ? setIEOffsets : setModernOffsets
};

module.exports = ReactDOMSelection;

},{"./ExecutionEnvironment":21,"./getNodeForCharacterOffset":119,"./getTextContentAccessor":121}],47:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDOMTextarea
 */

"use strict";

var AutoFocusMixin = require("./AutoFocusMixin");
var DOMPropertyOperations = require("./DOMPropertyOperations");
var LinkedValueUtils = require("./LinkedValueUtils");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");
var ReactDOM = require("./ReactDOM");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var invariant = require("./invariant");

var warning = require("./warning");

// Store a reference to the <textarea> `ReactDOMComponent`. TODO: use string
var textarea = ReactElement.createFactory(ReactDOM.textarea.type);

function forceUpdateIfMounted() {
  /*jshint validthis:true */
  if (this.isMounted()) {
    this.forceUpdate();
  }
}

/**
 * Implements a <textarea> native component that allows setting `value`, and
 * `defaultValue`. This differs from the traditional DOM API because value is
 * usually set as PCDATA children.
 *
 * If `value` is not supplied (or null/undefined), user actions that affect the
 * value will trigger updates to the element.
 *
 * If `value` is supplied (and not null/undefined), the rendered element will
 * not trigger updates to the element. Instead, the `value` prop must change in
 * order for the rendered element to be updated.
 *
 * The rendered element will be initialized with an empty value, the prop
 * `defaultValue` if specified, or the children content (deprecated).
 */
var ReactDOMTextarea = ReactCompositeComponent.createClass({
  displayName: 'ReactDOMTextarea',

  mixins: [AutoFocusMixin, LinkedValueUtils.Mixin, ReactBrowserComponentMixin],

  getInitialState: function() {
    var defaultValue = this.props.defaultValue;
    // TODO (yungsters): Remove support for children content in <textarea>.
    var children = this.props.children;
    if (children != null) {
      if ("production" !== process.env.NODE_ENV) {
        ("production" !== process.env.NODE_ENV ? warning(
          false,
          'Use the `defaultValue` or `value` props instead of setting ' +
          'children on <textarea>.'
        ) : null);
      }
      ("production" !== process.env.NODE_ENV ? invariant(
        defaultValue == null,
        'If you supply `defaultValue` on a <textarea>, do not pass children.'
      ) : invariant(defaultValue == null));
      if (Array.isArray(children)) {
        ("production" !== process.env.NODE_ENV ? invariant(
          children.length <= 1,
          '<textarea> can only have at most one child.'
        ) : invariant(children.length <= 1));
        children = children[0];
      }

      defaultValue = '' + children;
    }
    if (defaultValue == null) {
      defaultValue = '';
    }
    var value = LinkedValueUtils.getValue(this);
    return {
      // We save the initial value so that `ReactDOMComponent` doesn't update
      // `textContent` (unnecessary since we update value).
      // The initial value can be a boolean or object so that's why it's
      // forced to be a string.
      initialValue: '' + (value != null ? value : defaultValue)
    };
  },

  render: function() {
    // Clone `this.props` so we don't mutate the input.
    var props = assign({}, this.props);

    ("production" !== process.env.NODE_ENV ? invariant(
      props.dangerouslySetInnerHTML == null,
      '`dangerouslySetInnerHTML` does not make sense on <textarea>.'
    ) : invariant(props.dangerouslySetInnerHTML == null));

    props.defaultValue = null;
    props.value = null;
    props.onChange = this._handleChange;

    // Always set children to the same thing. In IE9, the selection range will
    // get reset if `textContent` is mutated.
    return textarea(props, this.state.initialValue);
  },

  componentDidUpdate: function(prevProps, prevState, prevContext) {
    var value = LinkedValueUtils.getValue(this);
    if (value != null) {
      var rootNode = this.getDOMNode();
      // Cast `value` to a string to ensure the value is set correctly. While
      // browsers typically do this as necessary, jsdom doesn't.
      DOMPropertyOperations.setValueForProperty(rootNode, 'value', '' + value);
    }
  },

  _handleChange: function(event) {
    var returnValue;
    var onChange = LinkedValueUtils.getOnChange(this);
    if (onChange) {
      returnValue = onChange.call(this, event);
    }
    ReactUpdates.asap(forceUpdateIfMounted, this);
    return returnValue;
  }

});

module.exports = ReactDOMTextarea;

}).call(this,require("ngpmcQ"))
},{"./AutoFocusMixin":1,"./DOMPropertyOperations":11,"./LinkedValueUtils":23,"./Object.assign":26,"./ReactBrowserComponentMixin":29,"./ReactCompositeComponent":34,"./ReactDOM":37,"./ReactElement":52,"./ReactUpdates":79,"./invariant":126,"./warning":145,"ngpmcQ":176}],48:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultBatchingStrategy
 */

"use strict";

var ReactUpdates = require("./ReactUpdates");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");

var RESET_BATCHED_UPDATES = {
  initialize: emptyFunction,
  close: function() {
    ReactDefaultBatchingStrategy.isBatchingUpdates = false;
  }
};

var FLUSH_BATCHED_UPDATES = {
  initialize: emptyFunction,
  close: ReactUpdates.flushBatchedUpdates.bind(ReactUpdates)
};

var TRANSACTION_WRAPPERS = [FLUSH_BATCHED_UPDATES, RESET_BATCHED_UPDATES];

function ReactDefaultBatchingStrategyTransaction() {
  this.reinitializeTransaction();
}

assign(
  ReactDefaultBatchingStrategyTransaction.prototype,
  Transaction.Mixin,
  {
    getTransactionWrappers: function() {
      return TRANSACTION_WRAPPERS;
    }
  }
);

var transaction = new ReactDefaultBatchingStrategyTransaction();

var ReactDefaultBatchingStrategy = {
  isBatchingUpdates: false,

  /**
   * Call the provided function in a context within which calls to `setState`
   * and friends are batched such that components aren't updated unnecessarily.
   */
  batchedUpdates: function(callback, a, b) {
    var alreadyBatchingUpdates = ReactDefaultBatchingStrategy.isBatchingUpdates;

    ReactDefaultBatchingStrategy.isBatchingUpdates = true;

    // The code is written this way to avoid extra allocations
    if (alreadyBatchingUpdates) {
      callback(a, b);
    } else {
      transaction.perform(callback, null, a, b);
    }
  }
};

module.exports = ReactDefaultBatchingStrategy;

},{"./Object.assign":26,"./ReactUpdates":79,"./Transaction":95,"./emptyFunction":107}],49:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultInjection
 */

"use strict";

var BeforeInputEventPlugin = require("./BeforeInputEventPlugin");
var ChangeEventPlugin = require("./ChangeEventPlugin");
var ClientReactRootIndex = require("./ClientReactRootIndex");
var CompositionEventPlugin = require("./CompositionEventPlugin");
var DefaultEventPluginOrder = require("./DefaultEventPluginOrder");
var EnterLeaveEventPlugin = require("./EnterLeaveEventPlugin");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var HTMLDOMPropertyConfig = require("./HTMLDOMPropertyConfig");
var MobileSafariClickEventPlugin = require("./MobileSafariClickEventPlugin");
var ReactBrowserComponentMixin = require("./ReactBrowserComponentMixin");
var ReactComponentBrowserEnvironment =
  require("./ReactComponentBrowserEnvironment");
var ReactDefaultBatchingStrategy = require("./ReactDefaultBatchingStrategy");
var ReactDOMComponent = require("./ReactDOMComponent");
var ReactDOMButton = require("./ReactDOMButton");
var ReactDOMForm = require("./ReactDOMForm");
var ReactDOMImg = require("./ReactDOMImg");
var ReactDOMInput = require("./ReactDOMInput");
var ReactDOMOption = require("./ReactDOMOption");
var ReactDOMSelect = require("./ReactDOMSelect");
var ReactDOMTextarea = require("./ReactDOMTextarea");
var ReactEventListener = require("./ReactEventListener");
var ReactInjection = require("./ReactInjection");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMount = require("./ReactMount");
var SelectEventPlugin = require("./SelectEventPlugin");
var ServerReactRootIndex = require("./ServerReactRootIndex");
var SimpleEventPlugin = require("./SimpleEventPlugin");
var SVGDOMPropertyConfig = require("./SVGDOMPropertyConfig");

var createFullPageComponent = require("./createFullPageComponent");

function inject() {
  ReactInjection.EventEmitter.injectReactEventListener(
    ReactEventListener
  );

  /**
   * Inject modules for resolving DOM hierarchy and plugin ordering.
   */
  ReactInjection.EventPluginHub.injectEventPluginOrder(DefaultEventPluginOrder);
  ReactInjection.EventPluginHub.injectInstanceHandle(ReactInstanceHandles);
  ReactInjection.EventPluginHub.injectMount(ReactMount);

  /**
   * Some important event plugins included by default (without having to require
   * them).
   */
  ReactInjection.EventPluginHub.injectEventPluginsByName({
    SimpleEventPlugin: SimpleEventPlugin,
    EnterLeaveEventPlugin: EnterLeaveEventPlugin,
    ChangeEventPlugin: ChangeEventPlugin,
    CompositionEventPlugin: CompositionEventPlugin,
    MobileSafariClickEventPlugin: MobileSafariClickEventPlugin,
    SelectEventPlugin: SelectEventPlugin,
    BeforeInputEventPlugin: BeforeInputEventPlugin
  });

  ReactInjection.NativeComponent.injectGenericComponentClass(
    ReactDOMComponent
  );

  ReactInjection.NativeComponent.injectComponentClasses({
    'button': ReactDOMButton,
    'form': ReactDOMForm,
    'img': ReactDOMImg,
    'input': ReactDOMInput,
    'option': ReactDOMOption,
    'select': ReactDOMSelect,
    'textarea': ReactDOMTextarea,

    'html': createFullPageComponent('html'),
    'head': createFullPageComponent('head'),
    'body': createFullPageComponent('body')
  });

  // This needs to happen after createFullPageComponent() otherwise the mixin
  // gets double injected.
  ReactInjection.CompositeComponent.injectMixin(ReactBrowserComponentMixin);

  ReactInjection.DOMProperty.injectDOMPropertyConfig(HTMLDOMPropertyConfig);
  ReactInjection.DOMProperty.injectDOMPropertyConfig(SVGDOMPropertyConfig);

  ReactInjection.EmptyComponent.injectEmptyComponent('noscript');

  ReactInjection.Updates.injectReconcileTransaction(
    ReactComponentBrowserEnvironment.ReactReconcileTransaction
  );
  ReactInjection.Updates.injectBatchingStrategy(
    ReactDefaultBatchingStrategy
  );

  ReactInjection.RootIndex.injectCreateReactRootIndex(
    ExecutionEnvironment.canUseDOM ?
      ClientReactRootIndex.createReactRootIndex :
      ServerReactRootIndex.createReactRootIndex
  );

  ReactInjection.Component.injectEnvironment(ReactComponentBrowserEnvironment);

  if ("production" !== process.env.NODE_ENV) {
    var url = (ExecutionEnvironment.canUseDOM && window.location.href) || '';
    if ((/[?&]react_perf\b/).test(url)) {
      var ReactDefaultPerf = require("./ReactDefaultPerf");
      ReactDefaultPerf.start();
    }
  }
}

module.exports = {
  inject: inject
};

}).call(this,require("ngpmcQ"))
},{"./BeforeInputEventPlugin":2,"./ChangeEventPlugin":6,"./ClientReactRootIndex":7,"./CompositionEventPlugin":8,"./DefaultEventPluginOrder":13,"./EnterLeaveEventPlugin":14,"./ExecutionEnvironment":21,"./HTMLDOMPropertyConfig":22,"./MobileSafariClickEventPlugin":25,"./ReactBrowserComponentMixin":29,"./ReactComponentBrowserEnvironment":33,"./ReactDOMButton":38,"./ReactDOMComponent":39,"./ReactDOMForm":40,"./ReactDOMImg":42,"./ReactDOMInput":43,"./ReactDOMOption":44,"./ReactDOMSelect":45,"./ReactDOMTextarea":47,"./ReactDefaultBatchingStrategy":48,"./ReactDefaultPerf":50,"./ReactEventListener":57,"./ReactInjection":58,"./ReactInstanceHandles":60,"./ReactMount":63,"./SVGDOMPropertyConfig":80,"./SelectEventPlugin":81,"./ServerReactRootIndex":82,"./SimpleEventPlugin":83,"./createFullPageComponent":103,"ngpmcQ":176}],50:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultPerf
 * @typechecks static-only
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var ReactDefaultPerfAnalysis = require("./ReactDefaultPerfAnalysis");
var ReactMount = require("./ReactMount");
var ReactPerf = require("./ReactPerf");

var performanceNow = require("./performanceNow");

function roundFloat(val) {
  return Math.floor(val * 100) / 100;
}

function addValue(obj, key, val) {
  obj[key] = (obj[key] || 0) + val;
}

var ReactDefaultPerf = {
  _allMeasurements: [], // last item in the list is the current one
  _mountStack: [0],
  _injected: false,

  start: function() {
    if (!ReactDefaultPerf._injected) {
      ReactPerf.injection.injectMeasure(ReactDefaultPerf.measure);
    }

    ReactDefaultPerf._allMeasurements.length = 0;
    ReactPerf.enableMeasure = true;
  },

  stop: function() {
    ReactPerf.enableMeasure = false;
  },

  getLastMeasurements: function() {
    return ReactDefaultPerf._allMeasurements;
  },

  printExclusive: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getExclusiveSummary(measurements);
    console.table(summary.map(function(item) {
      return {
        'Component class name': item.componentName,
        'Total inclusive time (ms)': roundFloat(item.inclusive),
        'Exclusive mount time (ms)': roundFloat(item.exclusive),
        'Exclusive render time (ms)': roundFloat(item.render),
        'Mount time per instance (ms)': roundFloat(item.exclusive / item.count),
        'Render time per instance (ms)': roundFloat(item.render / item.count),
        'Instances': item.count
      };
    }));
    // TODO: ReactDefaultPerfAnalysis.getTotalTime() does not return the correct
    // number.
  },

  printInclusive: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(measurements);
    console.table(summary.map(function(item) {
      return {
        'Owner > component': item.componentName,
        'Inclusive time (ms)': roundFloat(item.time),
        'Instances': item.count
      };
    }));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  getMeasurementsSummaryMap: function(measurements) {
    var summary = ReactDefaultPerfAnalysis.getInclusiveSummary(
      measurements,
      true
    );
    return summary.map(function(item) {
      return {
        'Owner > component': item.componentName,
        'Wasted time (ms)': item.time,
        'Instances': item.count
      };
    });
  },

  printWasted: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    console.table(ReactDefaultPerf.getMeasurementsSummaryMap(measurements));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  printDOM: function(measurements) {
    measurements = measurements || ReactDefaultPerf._allMeasurements;
    var summary = ReactDefaultPerfAnalysis.getDOMSummary(measurements);
    console.table(summary.map(function(item) {
      var result = {};
      result[DOMProperty.ID_ATTRIBUTE_NAME] = item.id;
      result['type'] = item.type;
      result['args'] = JSON.stringify(item.args);
      return result;
    }));
    console.log(
      'Total time:',
      ReactDefaultPerfAnalysis.getTotalTime(measurements).toFixed(2) + ' ms'
    );
  },

  _recordWrite: function(id, fnName, totalTime, args) {
    // TODO: totalTime isn't that useful since it doesn't count paints/reflows
    var writes =
      ReactDefaultPerf
        ._allMeasurements[ReactDefaultPerf._allMeasurements.length - 1]
        .writes;
    writes[id] = writes[id] || [];
    writes[id].push({
      type: fnName,
      time: totalTime,
      args: args
    });
  },

  measure: function(moduleName, fnName, func) {
    return function() {for (var args=[],$__0=0,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
      var totalTime;
      var rv;
      var start;

      if (fnName === '_renderNewRootComponent' ||
          fnName === 'flushBatchedUpdates') {
        // A "measurement" is a set of metrics recorded for each flush. We want
        // to group the metrics for a given flush together so we can look at the
        // components that rendered and the DOM operations that actually
        // happened to determine the amount of "wasted work" performed.
        ReactDefaultPerf._allMeasurements.push({
          exclusive: {},
          inclusive: {},
          render: {},
          counts: {},
          writes: {},
          displayNames: {},
          totalTime: 0
        });
        start = performanceNow();
        rv = func.apply(this, args);
        ReactDefaultPerf._allMeasurements[
          ReactDefaultPerf._allMeasurements.length - 1
        ].totalTime = performanceNow() - start;
        return rv;
      } else if (moduleName === 'ReactDOMIDOperations' ||
        moduleName === 'ReactComponentBrowserEnvironment') {
        start = performanceNow();
        rv = func.apply(this, args);
        totalTime = performanceNow() - start;

        if (fnName === 'mountImageIntoNode') {
          var mountID = ReactMount.getID(args[1]);
          ReactDefaultPerf._recordWrite(mountID, fnName, totalTime, args[0]);
        } else if (fnName === 'dangerouslyProcessChildrenUpdates') {
          // special format
          args[0].forEach(function(update) {
            var writeArgs = {};
            if (update.fromIndex !== null) {
              writeArgs.fromIndex = update.fromIndex;
            }
            if (update.toIndex !== null) {
              writeArgs.toIndex = update.toIndex;
            }
            if (update.textContent !== null) {
              writeArgs.textContent = update.textContent;
            }
            if (update.markupIndex !== null) {
              writeArgs.markup = args[1][update.markupIndex];
            }
            ReactDefaultPerf._recordWrite(
              update.parentID,
              update.type,
              totalTime,
              writeArgs
            );
          });
        } else {
          // basic format
          ReactDefaultPerf._recordWrite(
            args[0],
            fnName,
            totalTime,
            Array.prototype.slice.call(args, 1)
          );
        }
        return rv;
      } else if (moduleName === 'ReactCompositeComponent' && (
        fnName === 'mountComponent' ||
        fnName === 'updateComponent' || // TODO: receiveComponent()?
        fnName === '_renderValidatedComponent')) {

        var rootNodeID = fnName === 'mountComponent' ?
          args[0] :
          this._rootNodeID;
        var isRender = fnName === '_renderValidatedComponent';
        var isMount = fnName === 'mountComponent';

        var mountStack = ReactDefaultPerf._mountStack;
        var entry = ReactDefaultPerf._allMeasurements[
          ReactDefaultPerf._allMeasurements.length - 1
        ];

        if (isRender) {
          addValue(entry.counts, rootNodeID, 1);
        } else if (isMount) {
          mountStack.push(0);
        }

        start = performanceNow();
        rv = func.apply(this, args);
        totalTime = performanceNow() - start;

        if (isRender) {
          addValue(entry.render, rootNodeID, totalTime);
        } else if (isMount) {
          var subMountTime = mountStack.pop();
          mountStack[mountStack.length - 1] += totalTime;
          addValue(entry.exclusive, rootNodeID, totalTime - subMountTime);
          addValue(entry.inclusive, rootNodeID, totalTime);
        } else {
          addValue(entry.inclusive, rootNodeID, totalTime);
        }

        entry.displayNames[rootNodeID] = {
          current: this.constructor.displayName,
          owner: this._owner ? this._owner.constructor.displayName : '<root>'
        };

        return rv;
      } else {
        return func.apply(this, args);
      }
    };
  }
};

module.exports = ReactDefaultPerf;

},{"./DOMProperty":10,"./ReactDefaultPerfAnalysis":51,"./ReactMount":63,"./ReactPerf":68,"./performanceNow":139}],51:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactDefaultPerfAnalysis
 */

var assign = require("./Object.assign");

// Don't try to save users less than 1.2ms (a number I made up)
var DONT_CARE_THRESHOLD = 1.2;
var DOM_OPERATION_TYPES = {
  'mountImageIntoNode': 'set innerHTML',
  INSERT_MARKUP: 'set innerHTML',
  MOVE_EXISTING: 'move',
  REMOVE_NODE: 'remove',
  TEXT_CONTENT: 'set textContent',
  'updatePropertyByID': 'update attribute',
  'deletePropertyByID': 'delete attribute',
  'updateStylesByID': 'update styles',
  'updateInnerHTMLByID': 'set innerHTML',
  'dangerouslyReplaceNodeWithMarkupByID': 'replace'
};

function getTotalTime(measurements) {
  // TODO: return number of DOM ops? could be misleading.
  // TODO: measure dropped frames after reconcile?
  // TODO: log total time of each reconcile and the top-level component
  // class that triggered it.
  var totalTime = 0;
  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    totalTime += measurement.totalTime;
  }
  return totalTime;
}

function getDOMSummary(measurements) {
  var items = [];
  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var id;

    for (id in measurement.writes) {
      measurement.writes[id].forEach(function(write) {
        items.push({
          id: id,
          type: DOM_OPERATION_TYPES[write.type] || write.type,
          args: write.args
        });
      });
    }
  }
  return items;
}

function getExclusiveSummary(measurements) {
  var candidates = {};
  var displayName;

  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var allIDs = assign(
      {},
      measurement.exclusive,
      measurement.inclusive
    );

    for (var id in allIDs) {
      displayName = measurement.displayNames[id].current;

      candidates[displayName] = candidates[displayName] || {
        componentName: displayName,
        inclusive: 0,
        exclusive: 0,
        render: 0,
        count: 0
      };
      if (measurement.render[id]) {
        candidates[displayName].render += measurement.render[id];
      }
      if (measurement.exclusive[id]) {
        candidates[displayName].exclusive += measurement.exclusive[id];
      }
      if (measurement.inclusive[id]) {
        candidates[displayName].inclusive += measurement.inclusive[id];
      }
      if (measurement.counts[id]) {
        candidates[displayName].count += measurement.counts[id];
      }
    }
  }

  // Now make a sorted array with the results.
  var arr = [];
  for (displayName in candidates) {
    if (candidates[displayName].exclusive >= DONT_CARE_THRESHOLD) {
      arr.push(candidates[displayName]);
    }
  }

  arr.sort(function(a, b) {
    return b.exclusive - a.exclusive;
  });

  return arr;
}

function getInclusiveSummary(measurements, onlyClean) {
  var candidates = {};
  var inclusiveKey;

  for (var i = 0; i < measurements.length; i++) {
    var measurement = measurements[i];
    var allIDs = assign(
      {},
      measurement.exclusive,
      measurement.inclusive
    );
    var cleanComponents;

    if (onlyClean) {
      cleanComponents = getUnchangedComponents(measurement);
    }

    for (var id in allIDs) {
      if (onlyClean && !cleanComponents[id]) {
        continue;
      }

      var displayName = measurement.displayNames[id];

      // Inclusive time is not useful for many components without knowing where
      // they are instantiated. So we aggregate inclusive time with both the
      // owner and current displayName as the key.
      inclusiveKey = displayName.owner + ' > ' + displayName.current;

      candidates[inclusiveKey] = candidates[inclusiveKey] || {
        componentName: inclusiveKey,
        time: 0,
        count: 0
      };

      if (measurement.inclusive[id]) {
        candidates[inclusiveKey].time += measurement.inclusive[id];
      }
      if (measurement.counts[id]) {
        candidates[inclusiveKey].count += measurement.counts[id];
      }
    }
  }

  // Now make a sorted array with the results.
  var arr = [];
  for (inclusiveKey in candidates) {
    if (candidates[inclusiveKey].time >= DONT_CARE_THRESHOLD) {
      arr.push(candidates[inclusiveKey]);
    }
  }

  arr.sort(function(a, b) {
    return b.time - a.time;
  });

  return arr;
}

function getUnchangedComponents(measurement) {
  // For a given reconcile, look at which components did not actually
  // render anything to the DOM and return a mapping of their ID to
  // the amount of time it took to render the entire subtree.
  var cleanComponents = {};
  var dirtyLeafIDs = Object.keys(measurement.writes);
  var allIDs = assign({}, measurement.exclusive, measurement.inclusive);

  for (var id in allIDs) {
    var isDirty = false;
    // For each component that rendered, see if a component that triggered
    // a DOM op is in its subtree.
    for (var i = 0; i < dirtyLeafIDs.length; i++) {
      if (dirtyLeafIDs[i].indexOf(id) === 0) {
        isDirty = true;
        break;
      }
    }
    if (!isDirty && measurement.counts[id] > 0) {
      cleanComponents[id] = true;
    }
  }
  return cleanComponents;
}

var ReactDefaultPerfAnalysis = {
  getExclusiveSummary: getExclusiveSummary,
  getInclusiveSummary: getInclusiveSummary,
  getDOMSummary: getDOMSummary,
  getTotalTime: getTotalTime
};

module.exports = ReactDefaultPerfAnalysis;

},{"./Object.assign":26}],52:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactElement
 */

"use strict";

var ReactContext = require("./ReactContext");
var ReactCurrentOwner = require("./ReactCurrentOwner");

var warning = require("./warning");

var RESERVED_PROPS = {
  key: true,
  ref: true
};

/**
 * Warn for mutations.
 *
 * @internal
 * @param {object} object
 * @param {string} key
 */
function defineWarningProperty(object, key) {
  Object.defineProperty(object, key, {

    configurable: false,
    enumerable: true,

    get: function() {
      if (!this._store) {
        return null;
      }
      return this._store[key];
    },

    set: function(value) {
      ("production" !== process.env.NODE_ENV ? warning(
        false,
        'Don\'t set the ' + key + ' property of the component. ' +
        'Mutate the existing props object instead.'
      ) : null);
      this._store[key] = value;
    }

  });
}

/**
 * This is updated to true if the membrane is successfully created.
 */
var useMutationMembrane = false;

/**
 * Warn for mutations.
 *
 * @internal
 * @param {object} element
 */
function defineMutationMembrane(prototype) {
  try {
    var pseudoFrozenProperties = {
      props: true
    };
    for (var key in pseudoFrozenProperties) {
      defineWarningProperty(prototype, key);
    }
    useMutationMembrane = true;
  } catch (x) {
    // IE will fail on defineProperty
  }
}

/**
 * Base constructor for all React elements. This is only used to make this
 * work with a dynamic instanceof check. Nothing should live on this prototype.
 *
 * @param {*} type
 * @param {string|object} ref
 * @param {*} key
 * @param {*} props
 * @internal
 */
var ReactElement = function(type, key, ref, owner, context, props) {
  // Built-in properties that belong on the element
  this.type = type;
  this.key = key;
  this.ref = ref;

  // Record the component responsible for creating this element.
  this._owner = owner;

  // TODO: Deprecate withContext, and then the context becomes accessible
  // through the owner.
  this._context = context;

  if ("production" !== process.env.NODE_ENV) {
    // The validation flag and props are currently mutative. We put them on
    // an external backing store so that we can freeze the whole object.
    // This can be replaced with a WeakMap once they are implemented in
    // commonly used development environments.
    this._store = { validated: false, props: props };

    // We're not allowed to set props directly on the object so we early
    // return and rely on the prototype membrane to forward to the backing
    // store.
    if (useMutationMembrane) {
      Object.freeze(this);
      return;
    }
  }

  this.props = props;
};

// We intentionally don't expose the function on the constructor property.
// ReactElement should be indistinguishable from a plain object.
ReactElement.prototype = {
  _isReactElement: true
};

if ("production" !== process.env.NODE_ENV) {
  defineMutationMembrane(ReactElement.prototype);
}

ReactElement.createElement = function(type, config, children) {
  var propName;

  // Reserved names are extracted
  var props = {};

  var key = null;
  var ref = null;

  if (config != null) {
    ref = config.ref === undefined ? null : config.ref;
    if ("production" !== process.env.NODE_ENV) {
      ("production" !== process.env.NODE_ENV ? warning(
        config.key !== null,
        'createElement(...): Encountered component with a `key` of null. In ' +
        'a future version, this will be treated as equivalent to the string ' +
        '\'null\'; instead, provide an explicit key or use undefined.'
      ) : null);
    }
    // TODO: Change this back to `config.key === undefined`
    key = config.key == null ? null : '' + config.key;
    // Remaining properties are added to a new props object
    for (propName in config) {
      if (config.hasOwnProperty(propName) &&
          !RESERVED_PROPS.hasOwnProperty(propName)) {
        props[propName] = config[propName];
      }
    }
  }

  // Children can be more than one argument, and those are transferred onto
  // the newly allocated props object.
  var childrenLength = arguments.length - 2;
  if (childrenLength === 1) {
    props.children = children;
  } else if (childrenLength > 1) {
    var childArray = Array(childrenLength);
    for (var i = 0; i < childrenLength; i++) {
      childArray[i] = arguments[i + 2];
    }
    props.children = childArray;
  }

  // Resolve default props
  if (type && type.defaultProps) {
    var defaultProps = type.defaultProps;
    for (propName in defaultProps) {
      if (typeof props[propName] === 'undefined') {
        props[propName] = defaultProps[propName];
      }
    }
  }

  return new ReactElement(
    type,
    key,
    ref,
    ReactCurrentOwner.current,
    ReactContext.current,
    props
  );
};

ReactElement.createFactory = function(type) {
  var factory = ReactElement.createElement.bind(null, type);
  // Expose the type on the factory and the prototype so that it can be
  // easily accessed on elements. E.g. <Foo />.type === Foo.type.
  // This should not be named `constructor` since this may not be the function
  // that created the element, and it may not even be a constructor.
  factory.type = type;
  return factory;
};

ReactElement.cloneAndReplaceProps = function(oldElement, newProps) {
  var newElement = new ReactElement(
    oldElement.type,
    oldElement.key,
    oldElement.ref,
    oldElement._owner,
    oldElement._context,
    newProps
  );

  if ("production" !== process.env.NODE_ENV) {
    // If the key on the original is valid, then the clone is valid
    newElement._store.validated = oldElement._store.validated;
  }
  return newElement;
};

/**
 * @param {?object} object
 * @return {boolean} True if `object` is a valid component.
 * @final
 */
ReactElement.isValidElement = function(object) {
  // ReactTestUtils is often used outside of beforeEach where as React is
  // within it. This leads to two different instances of React on the same
  // page. To identify a element from a different React instance we use
  // a flag instead of an instanceof check.
  var isElement = !!(object && object._isReactElement);
  // if (isElement && !(object instanceof ReactElement)) {
  // This is an indicator that you're using multiple versions of React at the
  // same time. This will screw with ownership and stuff. Fix it, please.
  // TODO: We could possibly warn here.
  // }
  return isElement;
};

module.exports = ReactElement;

}).call(this,require("ngpmcQ"))
},{"./ReactContext":35,"./ReactCurrentOwner":36,"./warning":145,"ngpmcQ":176}],53:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactElementValidator
 */

/**
 * ReactElementValidator provides a wrapper around a element factory
 * which validates the props passed to the element. This is intended to be
 * used only in DEV and could be replaced by a static type checker for languages
 * that support it.
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactPropTypeLocations = require("./ReactPropTypeLocations");
var ReactCurrentOwner = require("./ReactCurrentOwner");

var monitorCodeUse = require("./monitorCodeUse");
var warning = require("./warning");

/**
 * Warn if there's no key explicitly set on dynamic arrays of children or
 * object keys are not valid. This allows us to keep track of children between
 * updates.
 */
var ownerHasKeyUseWarning = {
  'react_key_warning': {},
  'react_numeric_key_warning': {}
};
var ownerHasMonitoredObjectMap = {};

var loggedTypeFailures = {};

var NUMERIC_PROPERTY_REGEX = /^\d+$/;

/**
 * Gets the current owner's displayName for use in warnings.
 *
 * @internal
 * @return {?string} Display name or undefined
 */
function getCurrentOwnerDisplayName() {
  var current = ReactCurrentOwner.current;
  return current && current.constructor.displayName || undefined;
}

/**
 * Warn if the component doesn't have an explicit key assigned to it.
 * This component is in an array. The array could grow and shrink or be
 * reordered. All children that haven't already been validated are required to
 * have a "key" property assigned to it.
 *
 * @internal
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function validateExplicitKey(component, parentType) {
  if (component._store.validated || component.key != null) {
    return;
  }
  component._store.validated = true;

  warnAndMonitorForKeyUse(
    'react_key_warning',
    'Each child in an array should have a unique "key" prop.',
    component,
    parentType
  );
}

/**
 * Warn if the key is being defined as an object property but has an incorrect
 * value.
 *
 * @internal
 * @param {string} name Property name of the key.
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function validatePropertyKey(name, component, parentType) {
  if (!NUMERIC_PROPERTY_REGEX.test(name)) {
    return;
  }
  warnAndMonitorForKeyUse(
    'react_numeric_key_warning',
    'Child objects should have non-numeric keys so ordering is preserved.',
    component,
    parentType
  );
}

/**
 * Shared warning and monitoring code for the key warnings.
 *
 * @internal
 * @param {string} warningID The id used when logging.
 * @param {string} message The base warning that gets output.
 * @param {ReactComponent} component Component that requires a key.
 * @param {*} parentType component's parent's type.
 */
function warnAndMonitorForKeyUse(warningID, message, component, parentType) {
  var ownerName = getCurrentOwnerDisplayName();
  var parentName = parentType.displayName;

  var useName = ownerName || parentName;
  var memoizer = ownerHasKeyUseWarning[warningID];
  if (memoizer.hasOwnProperty(useName)) {
    return;
  }
  memoizer[useName] = true;

  message += ownerName ?
    (" Check the render method of " + ownerName + ".") :
    (" Check the renderComponent call using <" + parentName + ">.");

  // Usually the current owner is the offender, but if it accepts children as a
  // property, it may be the creator of the child that's responsible for
  // assigning it a key.
  var childOwnerName = null;
  if (component._owner && component._owner !== ReactCurrentOwner.current) {
    // Name of the component that originally created this child.
    childOwnerName = component._owner.constructor.displayName;

    message += (" It was passed a child from " + childOwnerName + ".");
  }

  message += ' See http://fb.me/react-warning-keys for more information.';
  monitorCodeUse(warningID, {
    component: useName,
    componentOwner: childOwnerName
  });
  console.warn(message);
}

/**
 * Log that we're using an object map. We're considering deprecating this
 * feature and replace it with proper Map and ImmutableMap data structures.
 *
 * @internal
 */
function monitorUseOfObjectMap() {
  var currentName = getCurrentOwnerDisplayName() || '';
  if (ownerHasMonitoredObjectMap.hasOwnProperty(currentName)) {
    return;
  }
  ownerHasMonitoredObjectMap[currentName] = true;
  monitorCodeUse('react_object_map_children');
}

/**
 * Ensure that every component either is passed in a static location, in an
 * array with an explicit keys property defined, or in an object literal
 * with valid key property.
 *
 * @internal
 * @param {*} component Statically passed child of any type.
 * @param {*} parentType component's parent's type.
 * @return {boolean}
 */
function validateChildKeys(component, parentType) {
  if (Array.isArray(component)) {
    for (var i = 0; i < component.length; i++) {
      var child = component[i];
      if (ReactElement.isValidElement(child)) {
        validateExplicitKey(child, parentType);
      }
    }
  } else if (ReactElement.isValidElement(component)) {
    // This component was passed in a valid location.
    component._store.validated = true;
  } else if (component && typeof component === 'object') {
    monitorUseOfObjectMap();
    for (var name in component) {
      validatePropertyKey(name, component[name], parentType);
    }
  }
}

/**
 * Assert that the props are valid
 *
 * @param {string} componentName Name of the component for error messages.
 * @param {object} propTypes Map of prop name to a ReactPropType
 * @param {object} props
 * @param {string} location e.g. "prop", "context", "child context"
 * @private
 */
function checkPropTypes(componentName, propTypes, props, location) {
  for (var propName in propTypes) {
    if (propTypes.hasOwnProperty(propName)) {
      var error;
      // Prop type validation may throw. In case they do, we don't want to
      // fail the render phase where it didn't fail before. So we log it.
      // After these have been cleaned up, we'll let them throw.
      try {
        error = propTypes[propName](props, propName, componentName, location);
      } catch (ex) {
        error = ex;
      }
      if (error instanceof Error && !(error.message in loggedTypeFailures)) {
        // Only monitor this failure once because there tends to be a lot of the
        // same error.
        loggedTypeFailures[error.message] = true;
        // This will soon use the warning module
        monitorCodeUse(
          'react_failed_descriptor_type_check',
          { message: error.message }
        );
      }
    }
  }
}

var ReactElementValidator = {

  createElement: function(type, props, children) {
    // We warn in this case but don't throw. We expect the element creation to
    // succeed and there will likely be errors in render.
    ("production" !== process.env.NODE_ENV ? warning(
      type != null,
      'React.createElement: type should not be null or undefined. It should ' +
        'be a string (for DOM elements) or a ReactClass (for composite ' +
        'components).'
    ) : null);

    var element = ReactElement.createElement.apply(this, arguments);

    // The result can be nullish if a mock or a custom function is used.
    // TODO: Drop this when these are no longer allowed as the type argument.
    if (element == null) {
      return element;
    }

    for (var i = 2; i < arguments.length; i++) {
      validateChildKeys(arguments[i], type);
    }

    if (type) {
      var name = type.displayName;
      if (type.propTypes) {
        checkPropTypes(
          name,
          type.propTypes,
          element.props,
          ReactPropTypeLocations.prop
        );
      }
      if (type.contextTypes) {
        checkPropTypes(
          name,
          type.contextTypes,
          element._context,
          ReactPropTypeLocations.context
        );
      }
    }
    return element;
  },

  createFactory: function(type) {
    var validatedFactory = ReactElementValidator.createElement.bind(
      null,
      type
    );
    validatedFactory.type = type;
    return validatedFactory;
  }

};

module.exports = ReactElementValidator;

}).call(this,require("ngpmcQ"))
},{"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactPropTypeLocations":71,"./monitorCodeUse":136,"./warning":145,"ngpmcQ":176}],54:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEmptyComponent
 */

"use strict";

var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

var component;
// This registry keeps track of the React IDs of the components that rendered to
// `null` (in reality a placeholder such as `noscript`)
var nullComponentIdsRegistry = {};

var ReactEmptyComponentInjection = {
  injectEmptyComponent: function(emptyComponent) {
    component = ReactElement.createFactory(emptyComponent);
  }
};

/**
 * @return {ReactComponent} component The injected empty component.
 */
function getEmptyComponent() {
  ("production" !== process.env.NODE_ENV ? invariant(
    component,
    'Trying to return null from a render, but no null placeholder component ' +
    'was injected.'
  ) : invariant(component));
  return component();
}

/**
 * Mark the component as having rendered to null.
 * @param {string} id Component's `_rootNodeID`.
 */
function registerNullComponentID(id) {
  nullComponentIdsRegistry[id] = true;
}

/**
 * Unmark the component as having rendered to null: it renders to something now.
 * @param {string} id Component's `_rootNodeID`.
 */
function deregisterNullComponentID(id) {
  delete nullComponentIdsRegistry[id];
}

/**
 * @param {string} id Component's `_rootNodeID`.
 * @return {boolean} True if the component is rendered to null.
 */
function isNullComponentID(id) {
  return nullComponentIdsRegistry[id];
}

var ReactEmptyComponent = {
  deregisterNullComponentID: deregisterNullComponentID,
  getEmptyComponent: getEmptyComponent,
  injection: ReactEmptyComponentInjection,
  isNullComponentID: isNullComponentID,
  registerNullComponentID: registerNullComponentID
};

module.exports = ReactEmptyComponent;

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./invariant":126,"ngpmcQ":176}],55:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactErrorUtils
 * @typechecks
 */

"use strict";

var ReactErrorUtils = {
  /**
   * Creates a guarded version of a function. This is supposed to make debugging
   * of event handlers easier. To aid debugging with the browser's debugger,
   * this currently simply returns the original function.
   *
   * @param {function} func Function to be executed
   * @param {string} name The name of the guard
   * @return {function}
   */
  guard: function(func, name) {
    return func;
  }
};

module.exports = ReactErrorUtils;

},{}],56:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventEmitterMixin
 */

"use strict";

var EventPluginHub = require("./EventPluginHub");

function runEventQueueInBatch(events) {
  EventPluginHub.enqueueEvents(events);
  EventPluginHub.processEventQueue();
}

var ReactEventEmitterMixin = {

  /**
   * Streams a fired top-level event to `EventPluginHub` where plugins have the
   * opportunity to create `ReactEvent`s to be dispatched.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {object} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native environment event.
   */
  handleTopLevel: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var events = EventPluginHub.extractEvents(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent
    );

    runEventQueueInBatch(events);
  }
};

module.exports = ReactEventEmitterMixin;

},{"./EventPluginHub":17}],57:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactEventListener
 * @typechecks static-only
 */

"use strict";

var EventListener = require("./EventListener");
var ExecutionEnvironment = require("./ExecutionEnvironment");
var PooledClass = require("./PooledClass");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMount = require("./ReactMount");
var ReactUpdates = require("./ReactUpdates");

var assign = require("./Object.assign");
var getEventTarget = require("./getEventTarget");
var getUnboundedScrollPosition = require("./getUnboundedScrollPosition");

/**
 * Finds the parent React component of `node`.
 *
 * @param {*} node
 * @return {?DOMEventTarget} Parent container, or `null` if the specified node
 *                           is not nested.
 */
function findParent(node) {
  // TODO: It may be a good idea to cache this to prevent unnecessary DOM
  // traversal, but caching is difficult to do correctly without using a
  // mutation observer to listen for all DOM changes.
  var nodeID = ReactMount.getID(node);
  var rootID = ReactInstanceHandles.getReactRootIDFromNodeID(nodeID);
  var container = ReactMount.findReactContainerForID(rootID);
  var parent = ReactMount.getFirstReactDOM(container);
  return parent;
}

// Used to store ancestor hierarchy in top level callback
function TopLevelCallbackBookKeeping(topLevelType, nativeEvent) {
  this.topLevelType = topLevelType;
  this.nativeEvent = nativeEvent;
  this.ancestors = [];
}
assign(TopLevelCallbackBookKeeping.prototype, {
  destructor: function() {
    this.topLevelType = null;
    this.nativeEvent = null;
    this.ancestors.length = 0;
  }
});
PooledClass.addPoolingTo(
  TopLevelCallbackBookKeeping,
  PooledClass.twoArgumentPooler
);

function handleTopLevelImpl(bookKeeping) {
  var topLevelTarget = ReactMount.getFirstReactDOM(
    getEventTarget(bookKeeping.nativeEvent)
  ) || window;

  // Loop through the hierarchy, in case there's any nested components.
  // It's important that we build the array of ancestors before calling any
  // event handlers, because event handlers can modify the DOM, leading to
  // inconsistencies with ReactMount's node cache. See #1105.
  var ancestor = topLevelTarget;
  while (ancestor) {
    bookKeeping.ancestors.push(ancestor);
    ancestor = findParent(ancestor);
  }

  for (var i = 0, l = bookKeeping.ancestors.length; i < l; i++) {
    topLevelTarget = bookKeeping.ancestors[i];
    var topLevelTargetID = ReactMount.getID(topLevelTarget) || '';
    ReactEventListener._handleTopLevel(
      bookKeeping.topLevelType,
      topLevelTarget,
      topLevelTargetID,
      bookKeeping.nativeEvent
    );
  }
}

function scrollValueMonitor(cb) {
  var scrollPosition = getUnboundedScrollPosition(window);
  cb(scrollPosition);
}

var ReactEventListener = {
  _enabled: true,
  _handleTopLevel: null,

  WINDOW_HANDLE: ExecutionEnvironment.canUseDOM ? window : null,

  setHandleTopLevel: function(handleTopLevel) {
    ReactEventListener._handleTopLevel = handleTopLevel;
  },

  setEnabled: function(enabled) {
    ReactEventListener._enabled = !!enabled;
  },

  isEnabled: function() {
    return ReactEventListener._enabled;
  },


  /**
   * Traps top-level events by using event bubbling.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapBubbledEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return;
    }
    return EventListener.listen(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  /**
   * Traps a top-level event by using event capturing.
   *
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {string} handlerBaseName Event name (e.g. "click").
   * @param {object} handle Element on which to attach listener.
   * @return {object} An object with a remove function which will forcefully
   *                  remove the listener.
   * @internal
   */
  trapCapturedEvent: function(topLevelType, handlerBaseName, handle) {
    var element = handle;
    if (!element) {
      return;
    }
    return EventListener.capture(
      element,
      handlerBaseName,
      ReactEventListener.dispatchEvent.bind(null, topLevelType)
    );
  },

  monitorScrollValue: function(refresh) {
    var callback = scrollValueMonitor.bind(null, refresh);
    EventListener.listen(window, 'scroll', callback);
    EventListener.listen(window, 'resize', callback);
  },

  dispatchEvent: function(topLevelType, nativeEvent) {
    if (!ReactEventListener._enabled) {
      return;
    }

    var bookKeeping = TopLevelCallbackBookKeeping.getPooled(
      topLevelType,
      nativeEvent
    );
    try {
      // Event queue being processed in the same cycle allows
      // `preventDefault`.
      ReactUpdates.batchedUpdates(handleTopLevelImpl, bookKeeping);
    } finally {
      TopLevelCallbackBookKeeping.release(bookKeeping);
    }
  }
};

module.exports = ReactEventListener;

},{"./EventListener":16,"./ExecutionEnvironment":21,"./Object.assign":26,"./PooledClass":27,"./ReactInstanceHandles":60,"./ReactMount":63,"./ReactUpdates":79,"./getEventTarget":117,"./getUnboundedScrollPosition":122}],58:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInjection
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var EventPluginHub = require("./EventPluginHub");
var ReactComponent = require("./ReactComponent");
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactEmptyComponent = require("./ReactEmptyComponent");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactNativeComponent = require("./ReactNativeComponent");
var ReactPerf = require("./ReactPerf");
var ReactRootIndex = require("./ReactRootIndex");
var ReactUpdates = require("./ReactUpdates");

var ReactInjection = {
  Component: ReactComponent.injection,
  CompositeComponent: ReactCompositeComponent.injection,
  DOMProperty: DOMProperty.injection,
  EmptyComponent: ReactEmptyComponent.injection,
  EventPluginHub: EventPluginHub.injection,
  EventEmitter: ReactBrowserEventEmitter.injection,
  NativeComponent: ReactNativeComponent.injection,
  Perf: ReactPerf.injection,
  RootIndex: ReactRootIndex.injection,
  Updates: ReactUpdates.injection
};

module.exports = ReactInjection;

},{"./DOMProperty":10,"./EventPluginHub":17,"./ReactBrowserEventEmitter":30,"./ReactComponent":32,"./ReactCompositeComponent":34,"./ReactEmptyComponent":54,"./ReactNativeComponent":66,"./ReactPerf":68,"./ReactRootIndex":75,"./ReactUpdates":79}],59:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInputSelection
 */

"use strict";

var ReactDOMSelection = require("./ReactDOMSelection");

var containsNode = require("./containsNode");
var focusNode = require("./focusNode");
var getActiveElement = require("./getActiveElement");

function isInDocument(node) {
  return containsNode(document.documentElement, node);
}

/**
 * @ReactInputSelection: React input selection module. Based on Selection.js,
 * but modified to be suitable for react and has a couple of bug fixes (doesn't
 * assume buttons have range selections allowed).
 * Input selection module for React.
 */
var ReactInputSelection = {

  hasSelectionCapabilities: function(elem) {
    return elem && (
      (elem.nodeName === 'INPUT' && elem.type === 'text') ||
      elem.nodeName === 'TEXTAREA' ||
      elem.contentEditable === 'true'
    );
  },

  getSelectionInformation: function() {
    var focusedElem = getActiveElement();
    return {
      focusedElem: focusedElem,
      selectionRange:
          ReactInputSelection.hasSelectionCapabilities(focusedElem) ?
          ReactInputSelection.getSelection(focusedElem) :
          null
    };
  },

  /**
   * @restoreSelection: If any selection information was potentially lost,
   * restore it. This is useful when performing operations that could remove dom
   * nodes and place them back in, resulting in focus being lost.
   */
  restoreSelection: function(priorSelectionInformation) {
    var curFocusedElem = getActiveElement();
    var priorFocusedElem = priorSelectionInformation.focusedElem;
    var priorSelectionRange = priorSelectionInformation.selectionRange;
    if (curFocusedElem !== priorFocusedElem &&
        isInDocument(priorFocusedElem)) {
      if (ReactInputSelection.hasSelectionCapabilities(priorFocusedElem)) {
        ReactInputSelection.setSelection(
          priorFocusedElem,
          priorSelectionRange
        );
      }
      focusNode(priorFocusedElem);
    }
  },

  /**
   * @getSelection: Gets the selection bounds of a focused textarea, input or
   * contentEditable node.
   * -@input: Look up selection bounds of this input
   * -@return {start: selectionStart, end: selectionEnd}
   */
  getSelection: function(input) {
    var selection;

    if ('selectionStart' in input) {
      // Modern browser with input or textarea.
      selection = {
        start: input.selectionStart,
        end: input.selectionEnd
      };
    } else if (document.selection && input.nodeName === 'INPUT') {
      // IE8 input.
      var range = document.selection.createRange();
      // There can only be one selection per document in IE, so it must
      // be in our element.
      if (range.parentElement() === input) {
        selection = {
          start: -range.moveStart('character', -input.value.length),
          end: -range.moveEnd('character', -input.value.length)
        };
      }
    } else {
      // Content editable or old IE textarea.
      selection = ReactDOMSelection.getOffsets(input);
    }

    return selection || {start: 0, end: 0};
  },

  /**
   * @setSelection: Sets the selection bounds of a textarea or input and focuses
   * the input.
   * -@input     Set selection bounds of this input or textarea
   * -@offsets   Object of same form that is returned from get*
   */
  setSelection: function(input, offsets) {
    var start = offsets.start;
    var end = offsets.end;
    if (typeof end === 'undefined') {
      end = start;
    }

    if ('selectionStart' in input) {
      input.selectionStart = start;
      input.selectionEnd = Math.min(end, input.value.length);
    } else if (document.selection && input.nodeName === 'INPUT') {
      var range = input.createTextRange();
      range.collapse(true);
      range.moveStart('character', start);
      range.moveEnd('character', end - start);
      range.select();
    } else {
      ReactDOMSelection.setOffsets(input, offsets);
    }
  }
};

module.exports = ReactInputSelection;

},{"./ReactDOMSelection":46,"./containsNode":101,"./focusNode":111,"./getActiveElement":113}],60:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactInstanceHandles
 * @typechecks static-only
 */

"use strict";

var ReactRootIndex = require("./ReactRootIndex");

var invariant = require("./invariant");

var SEPARATOR = '.';
var SEPARATOR_LENGTH = SEPARATOR.length;

/**
 * Maximum depth of traversals before we consider the possibility of a bad ID.
 */
var MAX_TREE_DEPTH = 100;

/**
 * Creates a DOM ID prefix to use when mounting React components.
 *
 * @param {number} index A unique integer
 * @return {string} React root ID.
 * @internal
 */
function getReactRootIDString(index) {
  return SEPARATOR + index.toString(36);
}

/**
 * Checks if a character in the supplied ID is a separator or the end.
 *
 * @param {string} id A React DOM ID.
 * @param {number} index Index of the character to check.
 * @return {boolean} True if the character is a separator or end of the ID.
 * @private
 */
function isBoundary(id, index) {
  return id.charAt(index) === SEPARATOR || index === id.length;
}

/**
 * Checks if the supplied string is a valid React DOM ID.
 *
 * @param {string} id A React DOM ID, maybe.
 * @return {boolean} True if the string is a valid React DOM ID.
 * @private
 */
function isValidID(id) {
  return id === '' || (
    id.charAt(0) === SEPARATOR && id.charAt(id.length - 1) !== SEPARATOR
  );
}

/**
 * Checks if the first ID is an ancestor of or equal to the second ID.
 *
 * @param {string} ancestorID
 * @param {string} descendantID
 * @return {boolean} True if `ancestorID` is an ancestor of `descendantID`.
 * @internal
 */
function isAncestorIDOf(ancestorID, descendantID) {
  return (
    descendantID.indexOf(ancestorID) === 0 &&
    isBoundary(descendantID, ancestorID.length)
  );
}

/**
 * Gets the parent ID of the supplied React DOM ID, `id`.
 *
 * @param {string} id ID of a component.
 * @return {string} ID of the parent, or an empty string.
 * @private
 */
function getParentID(id) {
  return id ? id.substr(0, id.lastIndexOf(SEPARATOR)) : '';
}

/**
 * Gets the next DOM ID on the tree path from the supplied `ancestorID` to the
 * supplied `destinationID`. If they are equal, the ID is returned.
 *
 * @param {string} ancestorID ID of an ancestor node of `destinationID`.
 * @param {string} destinationID ID of the destination node.
 * @return {string} Next ID on the path from `ancestorID` to `destinationID`.
 * @private
 */
function getNextDescendantID(ancestorID, destinationID) {
  ("production" !== process.env.NODE_ENV ? invariant(
    isValidID(ancestorID) && isValidID(destinationID),
    'getNextDescendantID(%s, %s): Received an invalid React DOM ID.',
    ancestorID,
    destinationID
  ) : invariant(isValidID(ancestorID) && isValidID(destinationID)));
  ("production" !== process.env.NODE_ENV ? invariant(
    isAncestorIDOf(ancestorID, destinationID),
    'getNextDescendantID(...): React has made an invalid assumption about ' +
    'the DOM hierarchy. Expected `%s` to be an ancestor of `%s`.',
    ancestorID,
    destinationID
  ) : invariant(isAncestorIDOf(ancestorID, destinationID)));
  if (ancestorID === destinationID) {
    return ancestorID;
  }
  // Skip over the ancestor and the immediate separator. Traverse until we hit
  // another separator or we reach the end of `destinationID`.
  var start = ancestorID.length + SEPARATOR_LENGTH;
  for (var i = start; i < destinationID.length; i++) {
    if (isBoundary(destinationID, i)) {
      break;
    }
  }
  return destinationID.substr(0, i);
}

/**
 * Gets the nearest common ancestor ID of two IDs.
 *
 * Using this ID scheme, the nearest common ancestor ID is the longest common
 * prefix of the two IDs that immediately preceded a "marker" in both strings.
 *
 * @param {string} oneID
 * @param {string} twoID
 * @return {string} Nearest common ancestor ID, or the empty string if none.
 * @private
 */
function getFirstCommonAncestorID(oneID, twoID) {
  var minLength = Math.min(oneID.length, twoID.length);
  if (minLength === 0) {
    return '';
  }
  var lastCommonMarkerIndex = 0;
  // Use `<=` to traverse until the "EOL" of the shorter string.
  for (var i = 0; i <= minLength; i++) {
    if (isBoundary(oneID, i) && isBoundary(twoID, i)) {
      lastCommonMarkerIndex = i;
    } else if (oneID.charAt(i) !== twoID.charAt(i)) {
      break;
    }
  }
  var longestCommonID = oneID.substr(0, lastCommonMarkerIndex);
  ("production" !== process.env.NODE_ENV ? invariant(
    isValidID(longestCommonID),
    'getFirstCommonAncestorID(%s, %s): Expected a valid React DOM ID: %s',
    oneID,
    twoID,
    longestCommonID
  ) : invariant(isValidID(longestCommonID)));
  return longestCommonID;
}

/**
 * Traverses the parent path between two IDs (either up or down). The IDs must
 * not be the same, and there must exist a parent path between them. If the
 * callback returns `false`, traversal is stopped.
 *
 * @param {?string} start ID at which to start traversal.
 * @param {?string} stop ID at which to end traversal.
 * @param {function} cb Callback to invoke each ID with.
 * @param {?boolean} skipFirst Whether or not to skip the first node.
 * @param {?boolean} skipLast Whether or not to skip the last node.
 * @private
 */
function traverseParentPath(start, stop, cb, arg, skipFirst, skipLast) {
  start = start || '';
  stop = stop || '';
  ("production" !== process.env.NODE_ENV ? invariant(
    start !== stop,
    'traverseParentPath(...): Cannot traverse from and to the same ID, `%s`.',
    start
  ) : invariant(start !== stop));
  var traverseUp = isAncestorIDOf(stop, start);
  ("production" !== process.env.NODE_ENV ? invariant(
    traverseUp || isAncestorIDOf(start, stop),
    'traverseParentPath(%s, %s, ...): Cannot traverse from two IDs that do ' +
    'not have a parent path.',
    start,
    stop
  ) : invariant(traverseUp || isAncestorIDOf(start, stop)));
  // Traverse from `start` to `stop` one depth at a time.
  var depth = 0;
  var traverse = traverseUp ? getParentID : getNextDescendantID;
  for (var id = start; /* until break */; id = traverse(id, stop)) {
    var ret;
    if ((!skipFirst || id !== start) && (!skipLast || id !== stop)) {
      ret = cb(id, traverseUp, arg);
    }
    if (ret === false || id === stop) {
      // Only break //after// visiting `stop`.
      break;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      depth++ < MAX_TREE_DEPTH,
      'traverseParentPath(%s, %s, ...): Detected an infinite loop while ' +
      'traversing the React DOM ID tree. This may be due to malformed IDs: %s',
      start, stop
    ) : invariant(depth++ < MAX_TREE_DEPTH));
  }
}

/**
 * Manages the IDs assigned to DOM representations of React components. This
 * uses a specific scheme in order to traverse the DOM efficiently (e.g. in
 * order to simulate events).
 *
 * @internal
 */
var ReactInstanceHandles = {

  /**
   * Constructs a React root ID
   * @return {string} A React root ID.
   */
  createReactRootID: function() {
    return getReactRootIDString(ReactRootIndex.createReactRootIndex());
  },

  /**
   * Constructs a React ID by joining a root ID with a name.
   *
   * @param {string} rootID Root ID of a parent component.
   * @param {string} name A component's name (as flattened children).
   * @return {string} A React ID.
   * @internal
   */
  createReactID: function(rootID, name) {
    return rootID + name;
  },

  /**
   * Gets the DOM ID of the React component that is the root of the tree that
   * contains the React component with the supplied DOM ID.
   *
   * @param {string} id DOM ID of a React component.
   * @return {?string} DOM ID of the React component that is the root.
   * @internal
   */
  getReactRootIDFromNodeID: function(id) {
    if (id && id.charAt(0) === SEPARATOR && id.length > 1) {
      var index = id.indexOf(SEPARATOR, 1);
      return index > -1 ? id.substr(0, index) : id;
    }
    return null;
  },

  /**
   * Traverses the ID hierarchy and invokes the supplied `cb` on any IDs that
   * should would receive a `mouseEnter` or `mouseLeave` event.
   *
   * NOTE: Does not invoke the callback on the nearest common ancestor because
   * nothing "entered" or "left" that element.
   *
   * @param {string} leaveID ID being left.
   * @param {string} enterID ID being entered.
   * @param {function} cb Callback to invoke on each entered/left ID.
   * @param {*} upArg Argument to invoke the callback with on left IDs.
   * @param {*} downArg Argument to invoke the callback with on entered IDs.
   * @internal
   */
  traverseEnterLeave: function(leaveID, enterID, cb, upArg, downArg) {
    var ancestorID = getFirstCommonAncestorID(leaveID, enterID);
    if (ancestorID !== leaveID) {
      traverseParentPath(leaveID, ancestorID, cb, upArg, false, true);
    }
    if (ancestorID !== enterID) {
      traverseParentPath(ancestorID, enterID, cb, downArg, true, false);
    }
  },

  /**
   * Simulates the traversal of a two-phase, capture/bubble event dispatch.
   *
   * NOTE: This traversal happens on IDs without touching the DOM.
   *
   * @param {string} targetID ID of the target node.
   * @param {function} cb Callback to invoke.
   * @param {*} arg Argument to invoke the callback with.
   * @internal
   */
  traverseTwoPhase: function(targetID, cb, arg) {
    if (targetID) {
      traverseParentPath('', targetID, cb, arg, true, false);
      traverseParentPath(targetID, '', cb, arg, false, true);
    }
  },

  /**
   * Traverse a node ID, calling the supplied `cb` for each ancestor ID. For
   * example, passing `.0.$row-0.1` would result in `cb` getting called
   * with `.0`, `.0.$row-0`, and `.0.$row-0.1`.
   *
   * NOTE: This traversal happens on IDs without touching the DOM.
   *
   * @param {string} targetID ID of the target node.
   * @param {function} cb Callback to invoke.
   * @param {*} arg Argument to invoke the callback with.
   * @internal
   */
  traverseAncestors: function(targetID, cb, arg) {
    traverseParentPath('', targetID, cb, arg, true, false);
  },

  /**
   * Exposed for unit testing.
   * @private
   */
  _getFirstCommonAncestorID: getFirstCommonAncestorID,

  /**
   * Exposed for unit testing.
   * @private
   */
  _getNextDescendantID: getNextDescendantID,

  isAncestorIDOf: isAncestorIDOf,

  SEPARATOR: SEPARATOR

};

module.exports = ReactInstanceHandles;

}).call(this,require("ngpmcQ"))
},{"./ReactRootIndex":75,"./invariant":126,"ngpmcQ":176}],61:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactLegacyElement
 */

"use strict";

var ReactCurrentOwner = require("./ReactCurrentOwner");

var invariant = require("./invariant");
var monitorCodeUse = require("./monitorCodeUse");
var warning = require("./warning");

var legacyFactoryLogs = {};
function warnForLegacyFactoryCall() {
  if (!ReactLegacyElementFactory._isLegacyCallWarningEnabled) {
    return;
  }
  var owner = ReactCurrentOwner.current;
  var name = owner && owner.constructor ? owner.constructor.displayName : '';
  if (!name) {
    name = 'Something';
  }
  if (legacyFactoryLogs.hasOwnProperty(name)) {
    return;
  }
  legacyFactoryLogs[name] = true;
  ("production" !== process.env.NODE_ENV ? warning(
    false,
    name + ' is calling a React component directly. ' +
    'Use a factory or JSX instead. See: http://fb.me/react-legacyfactory'
  ) : null);
  monitorCodeUse('react_legacy_factory_call', { version: 3, name: name });
}

function warnForPlainFunctionType(type) {
  var isReactClass =
    type.prototype &&
    typeof type.prototype.mountComponent === 'function' &&
    typeof type.prototype.receiveComponent === 'function';
  if (isReactClass) {
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'Did not expect to get a React class here. Use `Component` instead ' +
      'of `Component.type` or `this.constructor`.'
    ) : null);
  } else {
    if (!type._reactWarnedForThisType) {
      try {
        type._reactWarnedForThisType = true;
      } catch (x) {
        // just incase this is a frozen object or some special object
      }
      monitorCodeUse(
        'react_non_component_in_jsx',
        { version: 3, name: type.name }
      );
    }
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'This JSX uses a plain function. Only React components are ' +
      'valid in React\'s JSX transform.'
    ) : null);
  }
}

function warnForNonLegacyFactory(type) {
  ("production" !== process.env.NODE_ENV ? warning(
    false,
    'Do not pass React.DOM.' + type.type + ' to JSX or createFactory. ' +
    'Use the string "' + type.type + '" instead.'
  ) : null);
}

/**
 * Transfer static properties from the source to the target. Functions are
 * rebound to have this reflect the original source.
 */
function proxyStaticMethods(target, source) {
  if (typeof source !== 'function') {
    return;
  }
  for (var key in source) {
    if (source.hasOwnProperty(key)) {
      var value = source[key];
      if (typeof value === 'function') {
        var bound = value.bind(source);
        // Copy any properties defined on the function, such as `isRequired` on
        // a PropTypes validator.
        for (var k in value) {
          if (value.hasOwnProperty(k)) {
            bound[k] = value[k];
          }
        }
        target[key] = bound;
      } else {
        target[key] = value;
      }
    }
  }
}

// We use an object instead of a boolean because booleans are ignored by our
// mocking libraries when these factories gets mocked.
var LEGACY_MARKER = {};
var NON_LEGACY_MARKER = {};

var ReactLegacyElementFactory = {};

ReactLegacyElementFactory.wrapCreateFactory = function(createFactory) {
  var legacyCreateFactory = function(type) {
    if (typeof type !== 'function') {
      // Non-function types cannot be legacy factories
      return createFactory(type);
    }

    if (type.isReactNonLegacyFactory) {
      // This is probably a factory created by ReactDOM we unwrap it to get to
      // the underlying string type. It shouldn't have been passed here so we
      // warn.
      if ("production" !== process.env.NODE_ENV) {
        warnForNonLegacyFactory(type);
      }
      return createFactory(type.type);
    }

    if (type.isReactLegacyFactory) {
      // This is probably a legacy factory created by ReactCompositeComponent.
      // We unwrap it to get to the underlying class.
      return createFactory(type.type);
    }

    if ("production" !== process.env.NODE_ENV) {
      warnForPlainFunctionType(type);
    }

    // Unless it's a legacy factory, then this is probably a plain function,
    // that is expecting to be invoked by JSX. We can just return it as is.
    return type;
  };
  return legacyCreateFactory;
};

ReactLegacyElementFactory.wrapCreateElement = function(createElement) {
  var legacyCreateElement = function(type, props, children) {
    if (typeof type !== 'function') {
      // Non-function types cannot be legacy factories
      return createElement.apply(this, arguments);
    }

    var args;

    if (type.isReactNonLegacyFactory) {
      // This is probably a factory created by ReactDOM we unwrap it to get to
      // the underlying string type. It shouldn't have been passed here so we
      // warn.
      if ("production" !== process.env.NODE_ENV) {
        warnForNonLegacyFactory(type);
      }
      args = Array.prototype.slice.call(arguments, 0);
      args[0] = type.type;
      return createElement.apply(this, args);
    }

    if (type.isReactLegacyFactory) {
      // This is probably a legacy factory created by ReactCompositeComponent.
      // We unwrap it to get to the underlying class.
      if (type._isMockFunction) {
        // If this is a mock function, people will expect it to be called. We
        // will actually call the original mock factory function instead. This
        // future proofs unit testing that assume that these are classes.
        type.type._mockedReactClassConstructor = type;
      }
      args = Array.prototype.slice.call(arguments, 0);
      args[0] = type.type;
      return createElement.apply(this, args);
    }

    if ("production" !== process.env.NODE_ENV) {
      warnForPlainFunctionType(type);
    }

    // This is being called with a plain function we should invoke it
    // immediately as if this was used with legacy JSX.
    return type.apply(null, Array.prototype.slice.call(arguments, 1));
  };
  return legacyCreateElement;
};

ReactLegacyElementFactory.wrapFactory = function(factory) {
  ("production" !== process.env.NODE_ENV ? invariant(
    typeof factory === 'function',
    'This is suppose to accept a element factory'
  ) : invariant(typeof factory === 'function'));
  var legacyElementFactory = function(config, children) {
    // This factory should not be called when JSX is used. Use JSX instead.
    if ("production" !== process.env.NODE_ENV) {
      warnForLegacyFactoryCall();
    }
    return factory.apply(this, arguments);
  };
  proxyStaticMethods(legacyElementFactory, factory.type);
  legacyElementFactory.isReactLegacyFactory = LEGACY_MARKER;
  legacyElementFactory.type = factory.type;
  return legacyElementFactory;
};

// This is used to mark a factory that will remain. E.g. we're allowed to call
// it as a function. However, you're not suppose to pass it to createElement
// or createFactory, so it will warn you if you do.
ReactLegacyElementFactory.markNonLegacyFactory = function(factory) {
  factory.isReactNonLegacyFactory = NON_LEGACY_MARKER;
  return factory;
};

// Checks if a factory function is actually a legacy factory pretending to
// be a class.
ReactLegacyElementFactory.isValidFactory = function(factory) {
  // TODO: This will be removed and moved into a class validator or something.
  return typeof factory === 'function' &&
    factory.isReactLegacyFactory === LEGACY_MARKER;
};

ReactLegacyElementFactory.isValidClass = function(factory) {
  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      false,
      'isValidClass is deprecated and will be removed in a future release. ' +
      'Use a more specific validator instead.'
    ) : null);
  }
  return ReactLegacyElementFactory.isValidFactory(factory);
};

ReactLegacyElementFactory._isLegacyCallWarningEnabled = true;

module.exports = ReactLegacyElementFactory;

}).call(this,require("ngpmcQ"))
},{"./ReactCurrentOwner":36,"./invariant":126,"./monitorCodeUse":136,"./warning":145,"ngpmcQ":176}],62:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMarkupChecksum
 */

"use strict";

var adler32 = require("./adler32");

var ReactMarkupChecksum = {
  CHECKSUM_ATTR_NAME: 'data-react-checksum',

  /**
   * @param {string} markup Markup string
   * @return {string} Markup string with checksum attribute attached
   */
  addChecksumToMarkup: function(markup) {
    var checksum = adler32(markup);
    return markup.replace(
      '>',
      ' ' + ReactMarkupChecksum.CHECKSUM_ATTR_NAME + '="' + checksum + '">'
    );
  },

  /**
   * @param {string} markup to use
   * @param {DOMElement} element root React element
   * @returns {boolean} whether or not the markup is the same
   */
  canReuseMarkup: function(markup, element) {
    var existingChecksum = element.getAttribute(
      ReactMarkupChecksum.CHECKSUM_ATTR_NAME
    );
    existingChecksum = existingChecksum && parseInt(existingChecksum, 10);
    var markupChecksum = adler32(markup);
    return markupChecksum === existingChecksum;
  }
};

module.exports = ReactMarkupChecksum;

},{"./adler32":98}],63:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMount
 */

"use strict";

var DOMProperty = require("./DOMProperty");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactElement = require("./ReactElement");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactPerf = require("./ReactPerf");

var containsNode = require("./containsNode");
var deprecated = require("./deprecated");
var getReactRootElementInContainer = require("./getReactRootElementInContainer");
var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");
var warning = require("./warning");

var createElement = ReactLegacyElement.wrapCreateElement(
  ReactElement.createElement
);

var SEPARATOR = ReactInstanceHandles.SEPARATOR;

var ATTR_NAME = DOMProperty.ID_ATTRIBUTE_NAME;
var nodeCache = {};

var ELEMENT_NODE_TYPE = 1;
var DOC_NODE_TYPE = 9;

/** Mapping from reactRootID to React component instance. */
var instancesByReactRootID = {};

/** Mapping from reactRootID to `container` nodes. */
var containersByReactRootID = {};

if ("production" !== process.env.NODE_ENV) {
  /** __DEV__-only mapping from reactRootID to root elements. */
  var rootElementsByReactRootID = {};
}

// Used to store breadth-first search state in findComponentRoot.
var findComponentRootReusableArray = [];

/**
 * @param {DOMElement} container DOM element that may contain a React component.
 * @return {?string} A "reactRoot" ID, if a React component is rendered.
 */
function getReactRootID(container) {
  var rootElement = getReactRootElementInContainer(container);
  return rootElement && ReactMount.getID(rootElement);
}

/**
 * Accessing node[ATTR_NAME] or calling getAttribute(ATTR_NAME) on a form
 * element can return its control whose name or ID equals ATTR_NAME. All
 * DOM nodes support `getAttributeNode` but this can also get called on
 * other objects so just return '' if we're given something other than a
 * DOM node (such as window).
 *
 * @param {?DOMElement|DOMWindow|DOMDocument|DOMTextNode} node DOM node.
 * @return {string} ID of the supplied `domNode`.
 */
function getID(node) {
  var id = internalGetID(node);
  if (id) {
    if (nodeCache.hasOwnProperty(id)) {
      var cached = nodeCache[id];
      if (cached !== node) {
        ("production" !== process.env.NODE_ENV ? invariant(
          !isValid(cached, id),
          'ReactMount: Two valid but unequal nodes with the same `%s`: %s',
          ATTR_NAME, id
        ) : invariant(!isValid(cached, id)));

        nodeCache[id] = node;
      }
    } else {
      nodeCache[id] = node;
    }
  }

  return id;
}

function internalGetID(node) {
  // If node is something like a window, document, or text node, none of
  // which support attributes or a .getAttribute method, gracefully return
  // the empty string, as if the attribute were missing.
  return node && node.getAttribute && node.getAttribute(ATTR_NAME) || '';
}

/**
 * Sets the React-specific ID of the given node.
 *
 * @param {DOMElement} node The DOM node whose ID will be set.
 * @param {string} id The value of the ID attribute.
 */
function setID(node, id) {
  var oldID = internalGetID(node);
  if (oldID !== id) {
    delete nodeCache[oldID];
  }
  node.setAttribute(ATTR_NAME, id);
  nodeCache[id] = node;
}

/**
 * Finds the node with the supplied React-generated DOM ID.
 *
 * @param {string} id A React-generated DOM ID.
 * @return {DOMElement} DOM node with the suppled `id`.
 * @internal
 */
function getNode(id) {
  if (!nodeCache.hasOwnProperty(id) || !isValid(nodeCache[id], id)) {
    nodeCache[id] = ReactMount.findReactNodeByID(id);
  }
  return nodeCache[id];
}

/**
 * A node is "valid" if it is contained by a currently mounted container.
 *
 * This means that the node does not have to be contained by a document in
 * order to be considered valid.
 *
 * @param {?DOMElement} node The candidate DOM node.
 * @param {string} id The expected ID of the node.
 * @return {boolean} Whether the node is contained by a mounted container.
 */
function isValid(node, id) {
  if (node) {
    ("production" !== process.env.NODE_ENV ? invariant(
      internalGetID(node) === id,
      'ReactMount: Unexpected modification of `%s`',
      ATTR_NAME
    ) : invariant(internalGetID(node) === id));

    var container = ReactMount.findReactContainerForID(id);
    if (container && containsNode(container, node)) {
      return true;
    }
  }

  return false;
}

/**
 * Causes the cache to forget about one React-specific ID.
 *
 * @param {string} id The ID to forget.
 */
function purgeID(id) {
  delete nodeCache[id];
}

var deepestNodeSoFar = null;
function findDeepestCachedAncestorImpl(ancestorID) {
  var ancestor = nodeCache[ancestorID];
  if (ancestor && isValid(ancestor, ancestorID)) {
    deepestNodeSoFar = ancestor;
  } else {
    // This node isn't populated in the cache, so presumably none of its
    // descendants are. Break out of the loop.
    return false;
  }
}

/**
 * Return the deepest cached node whose ID is a prefix of `targetID`.
 */
function findDeepestCachedAncestor(targetID) {
  deepestNodeSoFar = null;
  ReactInstanceHandles.traverseAncestors(
    targetID,
    findDeepestCachedAncestorImpl
  );

  var foundNode = deepestNodeSoFar;
  deepestNodeSoFar = null;
  return foundNode;
}

/**
 * Mounting is the process of initializing a React component by creatings its
 * representative DOM elements and inserting them into a supplied `container`.
 * Any prior content inside `container` is destroyed in the process.
 *
 *   ReactMount.render(
 *     component,
 *     document.getElementById('container')
 *   );
 *
 *   <div id="container">                   <-- Supplied `container`.
 *     <div data-reactid=".3">              <-- Rendered reactRoot of React
 *       // ...                                 component.
 *     </div>
 *   </div>
 *
 * Inside of `container`, the first element rendered is the "reactRoot".
 */
var ReactMount = {
  /** Exposed for debugging purposes **/
  _instancesByReactRootID: instancesByReactRootID,

  /**
   * This is a hook provided to support rendering React components while
   * ensuring that the apparent scroll position of its `container` does not
   * change.
   *
   * @param {DOMElement} container The `container` being rendered into.
   * @param {function} renderCallback This must be called once to do the render.
   */
  scrollMonitor: function(container, renderCallback) {
    renderCallback();
  },

  /**
   * Take a component that's already mounted into the DOM and replace its props
   * @param {ReactComponent} prevComponent component instance already in the DOM
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @param {?function} callback function triggered on completion
   */
  _updateRootComponent: function(
      prevComponent,
      nextComponent,
      container,
      callback) {
    var nextProps = nextComponent.props;
    ReactMount.scrollMonitor(container, function() {
      prevComponent.replaceProps(nextProps, callback);
    });

    if ("production" !== process.env.NODE_ENV) {
      // Record the root element in case it later gets transplanted.
      rootElementsByReactRootID[getReactRootID(container)] =
        getReactRootElementInContainer(container);
    }

    return prevComponent;
  },

  /**
   * Register a component into the instance map and starts scroll value
   * monitoring
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @return {string} reactRoot ID prefix
   */
  _registerComponent: function(nextComponent, container) {
    ("production" !== process.env.NODE_ENV ? invariant(
      container && (
        container.nodeType === ELEMENT_NODE_TYPE ||
        container.nodeType === DOC_NODE_TYPE
      ),
      '_registerComponent(...): Target container is not a DOM element.'
    ) : invariant(container && (
      container.nodeType === ELEMENT_NODE_TYPE ||
      container.nodeType === DOC_NODE_TYPE
    )));

    ReactBrowserEventEmitter.ensureScrollValueMonitoring();

    var reactRootID = ReactMount.registerContainer(container);
    instancesByReactRootID[reactRootID] = nextComponent;
    return reactRootID;
  },

  /**
   * Render a new component into the DOM.
   * @param {ReactComponent} nextComponent component instance to render
   * @param {DOMElement} container container to render into
   * @param {boolean} shouldReuseMarkup if we should skip the markup insertion
   * @return {ReactComponent} nextComponent
   */
  _renderNewRootComponent: ReactPerf.measure(
    'ReactMount',
    '_renderNewRootComponent',
    function(
        nextComponent,
        container,
        shouldReuseMarkup) {
      // Various parts of our code (such as ReactCompositeComponent's
      // _renderValidatedComponent) assume that calls to render aren't nested;
      // verify that that's the case.
      ("production" !== process.env.NODE_ENV ? warning(
        ReactCurrentOwner.current == null,
        '_renderNewRootComponent(): Render methods should be a pure function ' +
        'of props and state; triggering nested component updates from ' +
        'render is not allowed. If necessary, trigger nested updates in ' +
        'componentDidUpdate.'
      ) : null);

      var componentInstance = instantiateReactComponent(nextComponent, null);
      var reactRootID = ReactMount._registerComponent(
        componentInstance,
        container
      );
      componentInstance.mountComponentIntoNode(
        reactRootID,
        container,
        shouldReuseMarkup
      );

      if ("production" !== process.env.NODE_ENV) {
        // Record the root element in case it later gets transplanted.
        rootElementsByReactRootID[reactRootID] =
          getReactRootElementInContainer(container);
      }

      return componentInstance;
    }
  ),

  /**
   * Renders a React component into the DOM in the supplied `container`.
   *
   * If the React component was previously rendered into `container`, this will
   * perform an update on it and only mutate the DOM as necessary to reflect the
   * latest React component.
   *
   * @param {ReactElement} nextElement Component element to render.
   * @param {DOMElement} container DOM element to render into.
   * @param {?function} callback function triggered on completion
   * @return {ReactComponent} Component instance rendered in `container`.
   */
  render: function(nextElement, container, callback) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactElement.isValidElement(nextElement),
      'renderComponent(): Invalid component element.%s',
      (
        typeof nextElement === 'string' ?
          ' Instead of passing an element string, make sure to instantiate ' +
          'it by passing it to React.createElement.' :
        ReactLegacyElement.isValidFactory(nextElement) ?
          ' Instead of passing a component class, make sure to instantiate ' +
          'it by passing it to React.createElement.' :
        // Check if it quacks like a element
        typeof nextElement.props !== "undefined" ?
          ' This may be caused by unintentionally loading two independent ' +
          'copies of React.' :
          ''
      )
    ) : invariant(ReactElement.isValidElement(nextElement)));

    var prevComponent = instancesByReactRootID[getReactRootID(container)];

    if (prevComponent) {
      var prevElement = prevComponent._currentElement;
      if (shouldUpdateReactComponent(prevElement, nextElement)) {
        return ReactMount._updateRootComponent(
          prevComponent,
          nextElement,
          container,
          callback
        );
      } else {
        ReactMount.unmountComponentAtNode(container);
      }
    }

    var reactRootElement = getReactRootElementInContainer(container);
    var containerHasReactMarkup =
      reactRootElement && ReactMount.isRenderedByReact(reactRootElement);

    var shouldReuseMarkup = containerHasReactMarkup && !prevComponent;

    var component = ReactMount._renderNewRootComponent(
      nextElement,
      container,
      shouldReuseMarkup
    );
    callback && callback.call(component);
    return component;
  },

  /**
   * Constructs a component instance of `constructor` with `initialProps` and
   * renders it into the supplied `container`.
   *
   * @param {function} constructor React component constructor.
   * @param {?object} props Initial props of the component instance.
   * @param {DOMElement} container DOM element to render into.
   * @return {ReactComponent} Component instance rendered in `container`.
   */
  constructAndRenderComponent: function(constructor, props, container) {
    var element = createElement(constructor, props);
    return ReactMount.render(element, container);
  },

  /**
   * Constructs a component instance of `constructor` with `initialProps` and
   * renders it into a container node identified by supplied `id`.
   *
   * @param {function} componentConstructor React component constructor
   * @param {?object} props Initial props of the component instance.
   * @param {string} id ID of the DOM element to render into.
   * @return {ReactComponent} Component instance rendered in the container node.
   */
  constructAndRenderComponentByID: function(constructor, props, id) {
    var domNode = document.getElementById(id);
    ("production" !== process.env.NODE_ENV ? invariant(
      domNode,
      'Tried to get element with id of "%s" but it is not present on the page.',
      id
    ) : invariant(domNode));
    return ReactMount.constructAndRenderComponent(constructor, props, domNode);
  },

  /**
   * Registers a container node into which React components will be rendered.
   * This also creates the "reactRoot" ID that will be assigned to the element
   * rendered within.
   *
   * @param {DOMElement} container DOM element to register as a container.
   * @return {string} The "reactRoot" ID of elements rendered within.
   */
  registerContainer: function(container) {
    var reactRootID = getReactRootID(container);
    if (reactRootID) {
      // If one exists, make sure it is a valid "reactRoot" ID.
      reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(reactRootID);
    }
    if (!reactRootID) {
      // No valid "reactRoot" ID found, create one.
      reactRootID = ReactInstanceHandles.createReactRootID();
    }
    containersByReactRootID[reactRootID] = container;
    return reactRootID;
  },

  /**
   * Unmounts and destroys the React component rendered in the `container`.
   *
   * @param {DOMElement} container DOM element containing a React component.
   * @return {boolean} True if a component was found in and unmounted from
   *                   `container`
   */
  unmountComponentAtNode: function(container) {
    // Various parts of our code (such as ReactCompositeComponent's
    // _renderValidatedComponent) assume that calls to render aren't nested;
    // verify that that's the case. (Strictly speaking, unmounting won't cause a
    // render but we still don't expect to be in a render call here.)
    ("production" !== process.env.NODE_ENV ? warning(
      ReactCurrentOwner.current == null,
      'unmountComponentAtNode(): Render methods should be a pure function of ' +
      'props and state; triggering nested component updates from render is ' +
      'not allowed. If necessary, trigger nested updates in ' +
      'componentDidUpdate.'
    ) : null);

    var reactRootID = getReactRootID(container);
    var component = instancesByReactRootID[reactRootID];
    if (!component) {
      return false;
    }
    ReactMount.unmountComponentFromNode(component, container);
    delete instancesByReactRootID[reactRootID];
    delete containersByReactRootID[reactRootID];
    if ("production" !== process.env.NODE_ENV) {
      delete rootElementsByReactRootID[reactRootID];
    }
    return true;
  },

  /**
   * Unmounts a component and removes it from the DOM.
   *
   * @param {ReactComponent} instance React component instance.
   * @param {DOMElement} container DOM element to unmount from.
   * @final
   * @internal
   * @see {ReactMount.unmountComponentAtNode}
   */
  unmountComponentFromNode: function(instance, container) {
    instance.unmountComponent();

    if (container.nodeType === DOC_NODE_TYPE) {
      container = container.documentElement;
    }

    // http://jsperf.com/emptying-a-node
    while (container.lastChild) {
      container.removeChild(container.lastChild);
    }
  },

  /**
   * Finds the container DOM element that contains React component to which the
   * supplied DOM `id` belongs.
   *
   * @param {string} id The ID of an element rendered by a React component.
   * @return {?DOMElement} DOM element that contains the `id`.
   */
  findReactContainerForID: function(id) {
    var reactRootID = ReactInstanceHandles.getReactRootIDFromNodeID(id);
    var container = containersByReactRootID[reactRootID];

    if ("production" !== process.env.NODE_ENV) {
      var rootElement = rootElementsByReactRootID[reactRootID];
      if (rootElement && rootElement.parentNode !== container) {
        ("production" !== process.env.NODE_ENV ? invariant(
          // Call internalGetID here because getID calls isValid which calls
          // findReactContainerForID (this function).
          internalGetID(rootElement) === reactRootID,
          'ReactMount: Root element ID differed from reactRootID.'
        ) : invariant(// Call internalGetID here because getID calls isValid which calls
        // findReactContainerForID (this function).
        internalGetID(rootElement) === reactRootID));

        var containerChild = container.firstChild;
        if (containerChild &&
            reactRootID === internalGetID(containerChild)) {
          // If the container has a new child with the same ID as the old
          // root element, then rootElementsByReactRootID[reactRootID] is
          // just stale and needs to be updated. The case that deserves a
          // warning is when the container is empty.
          rootElementsByReactRootID[reactRootID] = containerChild;
        } else {
          console.warn(
            'ReactMount: Root element has been removed from its original ' +
            'container. New container:', rootElement.parentNode
          );
        }
      }
    }

    return container;
  },

  /**
   * Finds an element rendered by React with the supplied ID.
   *
   * @param {string} id ID of a DOM node in the React component.
   * @return {DOMElement} Root DOM node of the React component.
   */
  findReactNodeByID: function(id) {
    var reactRoot = ReactMount.findReactContainerForID(id);
    return ReactMount.findComponentRoot(reactRoot, id);
  },

  /**
   * True if the supplied `node` is rendered by React.
   *
   * @param {*} node DOM Element to check.
   * @return {boolean} True if the DOM Element appears to be rendered by React.
   * @internal
   */
  isRenderedByReact: function(node) {
    if (node.nodeType !== 1) {
      // Not a DOMElement, therefore not a React component
      return false;
    }
    var id = ReactMount.getID(node);
    return id ? id.charAt(0) === SEPARATOR : false;
  },

  /**
   * Traverses up the ancestors of the supplied node to find a node that is a
   * DOM representation of a React component.
   *
   * @param {*} node
   * @return {?DOMEventTarget}
   * @internal
   */
  getFirstReactDOM: function(node) {
    var current = node;
    while (current && current.parentNode !== current) {
      if (ReactMount.isRenderedByReact(current)) {
        return current;
      }
      current = current.parentNode;
    }
    return null;
  },

  /**
   * Finds a node with the supplied `targetID` inside of the supplied
   * `ancestorNode`.  Exploits the ID naming scheme to perform the search
   * quickly.
   *
   * @param {DOMEventTarget} ancestorNode Search from this root.
   * @pararm {string} targetID ID of the DOM representation of the component.
   * @return {DOMEventTarget} DOM node with the supplied `targetID`.
   * @internal
   */
  findComponentRoot: function(ancestorNode, targetID) {
    var firstChildren = findComponentRootReusableArray;
    var childIndex = 0;

    var deepestAncestor = findDeepestCachedAncestor(targetID) || ancestorNode;

    firstChildren[0] = deepestAncestor.firstChild;
    firstChildren.length = 1;

    while (childIndex < firstChildren.length) {
      var child = firstChildren[childIndex++];
      var targetChild;

      while (child) {
        var childID = ReactMount.getID(child);
        if (childID) {
          // Even if we find the node we're looking for, we finish looping
          // through its siblings to ensure they're cached so that we don't have
          // to revisit this node again. Otherwise, we make n^2 calls to getID
          // when visiting the many children of a single node in order.

          if (targetID === childID) {
            targetChild = child;
          } else if (ReactInstanceHandles.isAncestorIDOf(childID, targetID)) {
            // If we find a child whose ID is an ancestor of the given ID,
            // then we can be sure that we only want to search the subtree
            // rooted at this child, so we can throw out the rest of the
            // search state.
            firstChildren.length = childIndex = 0;
            firstChildren.push(child.firstChild);
          }

        } else {
          // If this child had no ID, then there's a chance that it was
          // injected automatically by the browser, as when a `<table>`
          // element sprouts an extra `<tbody>` child as a side effect of
          // `.innerHTML` parsing. Optimistically continue down this
          // branch, but not before examining the other siblings.
          firstChildren.push(child.firstChild);
        }

        child = child.nextSibling;
      }

      if (targetChild) {
        // Emptying firstChildren/findComponentRootReusableArray is
        // not necessary for correctness, but it helps the GC reclaim
        // any nodes that were left at the end of the search.
        firstChildren.length = 0;

        return targetChild;
      }
    }

    firstChildren.length = 0;

    ("production" !== process.env.NODE_ENV ? invariant(
      false,
      'findComponentRoot(..., %s): Unable to find element. This probably ' +
      'means the DOM was unexpectedly mutated (e.g., by the browser), ' +
      'usually due to forgetting a <tbody> when using tables, nesting tags ' +
      'like <form>, <p>, or <a>, or using non-SVG elements in an <svg> ' +
      'parent. ' +
      'Try inspecting the child nodes of the element with React ID `%s`.',
      targetID,
      ReactMount.getID(ancestorNode)
    ) : invariant(false));
  },


  /**
   * React ID utilities.
   */

  getReactRootID: getReactRootID,

  getID: getID,

  setID: setID,

  getNode: getNode,

  purgeID: purgeID
};

// Deprecations (remove for 0.13)
ReactMount.renderComponent = deprecated(
  'ReactMount',
  'renderComponent',
  'render',
  this,
  ReactMount.render
);

module.exports = ReactMount;

}).call(this,require("ngpmcQ"))
},{"./DOMProperty":10,"./ReactBrowserEventEmitter":30,"./ReactCurrentOwner":36,"./ReactElement":52,"./ReactInstanceHandles":60,"./ReactLegacyElement":61,"./ReactPerf":68,"./containsNode":101,"./deprecated":106,"./getReactRootElementInContainer":120,"./instantiateReactComponent":125,"./invariant":126,"./shouldUpdateReactComponent":142,"./warning":145,"ngpmcQ":176}],64:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMultiChild
 * @typechecks static-only
 */

"use strict";

var ReactComponent = require("./ReactComponent");
var ReactMultiChildUpdateTypes = require("./ReactMultiChildUpdateTypes");

var flattenChildren = require("./flattenChildren");
var instantiateReactComponent = require("./instantiateReactComponent");
var shouldUpdateReactComponent = require("./shouldUpdateReactComponent");

/**
 * Updating children of a component may trigger recursive updates. The depth is
 * used to batch recursive updates to render markup more efficiently.
 *
 * @type {number}
 * @private
 */
var updateDepth = 0;

/**
 * Queue of update configuration objects.
 *
 * Each object has a `type` property that is in `ReactMultiChildUpdateTypes`.
 *
 * @type {array<object>}
 * @private
 */
var updateQueue = [];

/**
 * Queue of markup to be rendered.
 *
 * @type {array<string>}
 * @private
 */
var markupQueue = [];

/**
 * Enqueues markup to be rendered and inserted at a supplied index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {string} markup Markup that renders into an element.
 * @param {number} toIndex Destination index.
 * @private
 */
function enqueueMarkup(parentID, markup, toIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.INSERT_MARKUP,
    markupIndex: markupQueue.push(markup) - 1,
    textContent: null,
    fromIndex: null,
    toIndex: toIndex
  });
}

/**
 * Enqueues moving an existing element to another index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {number} fromIndex Source index of the existing element.
 * @param {number} toIndex Destination index of the element.
 * @private
 */
function enqueueMove(parentID, fromIndex, toIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.MOVE_EXISTING,
    markupIndex: null,
    textContent: null,
    fromIndex: fromIndex,
    toIndex: toIndex
  });
}

/**
 * Enqueues removing an element at an index.
 *
 * @param {string} parentID ID of the parent component.
 * @param {number} fromIndex Index of the element to remove.
 * @private
 */
function enqueueRemove(parentID, fromIndex) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.REMOVE_NODE,
    markupIndex: null,
    textContent: null,
    fromIndex: fromIndex,
    toIndex: null
  });
}

/**
 * Enqueues setting the text content.
 *
 * @param {string} parentID ID of the parent component.
 * @param {string} textContent Text content to set.
 * @private
 */
function enqueueTextContent(parentID, textContent) {
  // NOTE: Null values reduce hidden classes.
  updateQueue.push({
    parentID: parentID,
    parentNode: null,
    type: ReactMultiChildUpdateTypes.TEXT_CONTENT,
    markupIndex: null,
    textContent: textContent,
    fromIndex: null,
    toIndex: null
  });
}

/**
 * Processes any enqueued updates.
 *
 * @private
 */
function processQueue() {
  if (updateQueue.length) {
    ReactComponent.BackendIDOperations.dangerouslyProcessChildrenUpdates(
      updateQueue,
      markupQueue
    );
    clearQueue();
  }
}

/**
 * Clears any enqueued updates.
 *
 * @private
 */
function clearQueue() {
  updateQueue.length = 0;
  markupQueue.length = 0;
}

/**
 * ReactMultiChild are capable of reconciling multiple children.
 *
 * @class ReactMultiChild
 * @internal
 */
var ReactMultiChild = {

  /**
   * Provides common functionality for components that must reconcile multiple
   * children. This is used by `ReactDOMComponent` to mount, update, and
   * unmount child components.
   *
   * @lends {ReactMultiChild.prototype}
   */
  Mixin: {

    /**
     * Generates a "mount image" for each of the supplied children. In the case
     * of `ReactDOMComponent`, a mount image is a string of markup.
     *
     * @param {?object} nestedChildren Nested child maps.
     * @return {array} An array of mounted representations.
     * @internal
     */
    mountChildren: function(nestedChildren, transaction) {
      var children = flattenChildren(nestedChildren);
      var mountImages = [];
      var index = 0;
      this._renderedChildren = children;
      for (var name in children) {
        var child = children[name];
        if (children.hasOwnProperty(name)) {
          // The rendered children must be turned into instances as they're
          // mounted.
          var childInstance = instantiateReactComponent(child, null);
          children[name] = childInstance;
          // Inlined for performance, see `ReactInstanceHandles.createReactID`.
          var rootID = this._rootNodeID + name;
          var mountImage = childInstance.mountComponent(
            rootID,
            transaction,
            this._mountDepth + 1
          );
          childInstance._mountIndex = index;
          mountImages.push(mountImage);
          index++;
        }
      }
      return mountImages;
    },

    /**
     * Replaces any rendered children with a text content string.
     *
     * @param {string} nextContent String of content.
     * @internal
     */
    updateTextContent: function(nextContent) {
      updateDepth++;
      var errorThrown = true;
      try {
        var prevChildren = this._renderedChildren;
        // Remove any rendered children.
        for (var name in prevChildren) {
          if (prevChildren.hasOwnProperty(name)) {
            this._unmountChildByName(prevChildren[name], name);
          }
        }
        // Set new text content.
        this.setTextContent(nextContent);
        errorThrown = false;
      } finally {
        updateDepth--;
        if (!updateDepth) {
          errorThrown ? clearQueue() : processQueue();
        }
      }
    },

    /**
     * Updates the rendered children with new children.
     *
     * @param {?object} nextNestedChildren Nested child maps.
     * @param {ReactReconcileTransaction} transaction
     * @internal
     */
    updateChildren: function(nextNestedChildren, transaction) {
      updateDepth++;
      var errorThrown = true;
      try {
        this._updateChildren(nextNestedChildren, transaction);
        errorThrown = false;
      } finally {
        updateDepth--;
        if (!updateDepth) {
          errorThrown ? clearQueue() : processQueue();
        }
      }
    },

    /**
     * Improve performance by isolating this hot code path from the try/catch
     * block in `updateChildren`.
     *
     * @param {?object} nextNestedChildren Nested child maps.
     * @param {ReactReconcileTransaction} transaction
     * @final
     * @protected
     */
    _updateChildren: function(nextNestedChildren, transaction) {
      var nextChildren = flattenChildren(nextNestedChildren);
      var prevChildren = this._renderedChildren;
      if (!nextChildren && !prevChildren) {
        return;
      }
      var name;
      // `nextIndex` will increment for each child in `nextChildren`, but
      // `lastIndex` will be the last index visited in `prevChildren`.
      var lastIndex = 0;
      var nextIndex = 0;
      for (name in nextChildren) {
        if (!nextChildren.hasOwnProperty(name)) {
          continue;
        }
        var prevChild = prevChildren && prevChildren[name];
        var prevElement = prevChild && prevChild._currentElement;
        var nextElement = nextChildren[name];
        if (shouldUpdateReactComponent(prevElement, nextElement)) {
          this.moveChild(prevChild, nextIndex, lastIndex);
          lastIndex = Math.max(prevChild._mountIndex, lastIndex);
          prevChild.receiveComponent(nextElement, transaction);
          prevChild._mountIndex = nextIndex;
        } else {
          if (prevChild) {
            // Update `lastIndex` before `_mountIndex` gets unset by unmounting.
            lastIndex = Math.max(prevChild._mountIndex, lastIndex);
            this._unmountChildByName(prevChild, name);
          }
          // The child must be instantiated before it's mounted.
          var nextChildInstance = instantiateReactComponent(
            nextElement,
            null
          );
          this._mountChildByNameAtIndex(
            nextChildInstance, name, nextIndex, transaction
          );
        }
        nextIndex++;
      }
      // Remove children that are no longer present.
      for (name in prevChildren) {
        if (prevChildren.hasOwnProperty(name) &&
            !(nextChildren && nextChildren[name])) {
          this._unmountChildByName(prevChildren[name], name);
        }
      }
    },

    /**
     * Unmounts all rendered children. This should be used to clean up children
     * when this component is unmounted.
     *
     * @internal
     */
    unmountChildren: function() {
      var renderedChildren = this._renderedChildren;
      for (var name in renderedChildren) {
        var renderedChild = renderedChildren[name];
        // TODO: When is this not true?
        if (renderedChild.unmountComponent) {
          renderedChild.unmountComponent();
        }
      }
      this._renderedChildren = null;
    },

    /**
     * Moves a child component to the supplied index.
     *
     * @param {ReactComponent} child Component to move.
     * @param {number} toIndex Destination index of the element.
     * @param {number} lastIndex Last index visited of the siblings of `child`.
     * @protected
     */
    moveChild: function(child, toIndex, lastIndex) {
      // If the index of `child` is less than `lastIndex`, then it needs to
      // be moved. Otherwise, we do not need to move it because a child will be
      // inserted or moved before `child`.
      if (child._mountIndex < lastIndex) {
        enqueueMove(this._rootNodeID, child._mountIndex, toIndex);
      }
    },

    /**
     * Creates a child component.
     *
     * @param {ReactComponent} child Component to create.
     * @param {string} mountImage Markup to insert.
     * @protected
     */
    createChild: function(child, mountImage) {
      enqueueMarkup(this._rootNodeID, mountImage, child._mountIndex);
    },

    /**
     * Removes a child component.
     *
     * @param {ReactComponent} child Child to remove.
     * @protected
     */
    removeChild: function(child) {
      enqueueRemove(this._rootNodeID, child._mountIndex);
    },

    /**
     * Sets this text content string.
     *
     * @param {string} textContent Text content to set.
     * @protected
     */
    setTextContent: function(textContent) {
      enqueueTextContent(this._rootNodeID, textContent);
    },

    /**
     * Mounts a child with the supplied name.
     *
     * NOTE: This is part of `updateChildren` and is here for readability.
     *
     * @param {ReactComponent} child Component to mount.
     * @param {string} name Name of the child.
     * @param {number} index Index at which to insert the child.
     * @param {ReactReconcileTransaction} transaction
     * @private
     */
    _mountChildByNameAtIndex: function(child, name, index, transaction) {
      // Inlined for performance, see `ReactInstanceHandles.createReactID`.
      var rootID = this._rootNodeID + name;
      var mountImage = child.mountComponent(
        rootID,
        transaction,
        this._mountDepth + 1
      );
      child._mountIndex = index;
      this.createChild(child, mountImage);
      this._renderedChildren = this._renderedChildren || {};
      this._renderedChildren[name] = child;
    },

    /**
     * Unmounts a rendered child by name.
     *
     * NOTE: This is part of `updateChildren` and is here for readability.
     *
     * @param {ReactComponent} child Component to unmount.
     * @param {string} name Name of the child in `this._renderedChildren`.
     * @private
     */
    _unmountChildByName: function(child, name) {
      this.removeChild(child);
      child._mountIndex = null;
      child.unmountComponent();
      delete this._renderedChildren[name];
    }

  }

};

module.exports = ReactMultiChild;

},{"./ReactComponent":32,"./ReactMultiChildUpdateTypes":65,"./flattenChildren":110,"./instantiateReactComponent":125,"./shouldUpdateReactComponent":142}],65:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactMultiChildUpdateTypes
 */

"use strict";

var keyMirror = require("./keyMirror");

/**
 * When a component's children are updated, a series of update configuration
 * objects are created in order to batch and serialize the required changes.
 *
 * Enumerates all the possible types of update configurations.
 *
 * @internal
 */
var ReactMultiChildUpdateTypes = keyMirror({
  INSERT_MARKUP: null,
  MOVE_EXISTING: null,
  REMOVE_NODE: null,
  TEXT_CONTENT: null
});

module.exports = ReactMultiChildUpdateTypes;

},{"./keyMirror":132}],66:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactNativeComponent
 */

"use strict";

var assign = require("./Object.assign");
var invariant = require("./invariant");

var genericComponentClass = null;
// This registry keeps track of wrapper classes around native tags
var tagToComponentClass = {};

var ReactNativeComponentInjection = {
  // This accepts a class that receives the tag string. This is a catch all
  // that can render any kind of tag.
  injectGenericComponentClass: function(componentClass) {
    genericComponentClass = componentClass;
  },
  // This accepts a keyed object with classes as values. Each key represents a
  // tag. That particular tag will use this class instead of the generic one.
  injectComponentClasses: function(componentClasses) {
    assign(tagToComponentClass, componentClasses);
  }
};

/**
 * Create an internal class for a specific tag.
 *
 * @param {string} tag The tag for which to create an internal instance.
 * @param {any} props The props passed to the instance constructor.
 * @return {ReactComponent} component The injected empty component.
 */
function createInstanceForTag(tag, props, parentType) {
  var componentClass = tagToComponentClass[tag];
  if (componentClass == null) {
    ("production" !== process.env.NODE_ENV ? invariant(
      genericComponentClass,
      'There is no registered component for the tag %s',
      tag
    ) : invariant(genericComponentClass));
    return new genericComponentClass(tag, props);
  }
  if (parentType === tag) {
    // Avoid recursion
    ("production" !== process.env.NODE_ENV ? invariant(
      genericComponentClass,
      'There is no registered component for the tag %s',
      tag
    ) : invariant(genericComponentClass));
    return new genericComponentClass(tag, props);
  }
  // Unwrap legacy factories
  return new componentClass.type(props);
}

var ReactNativeComponent = {
  createInstanceForTag: createInstanceForTag,
  injection: ReactNativeComponentInjection
};

module.exports = ReactNativeComponent;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./invariant":126,"ngpmcQ":176}],67:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactOwner
 */

"use strict";

var emptyObject = require("./emptyObject");
var invariant = require("./invariant");

/**
 * ReactOwners are capable of storing references to owned components.
 *
 * All components are capable of //being// referenced by owner components, but
 * only ReactOwner components are capable of //referencing// owned components.
 * The named reference is known as a "ref".
 *
 * Refs are available when mounted and updated during reconciliation.
 *
 *   var MyComponent = React.createClass({
 *     render: function() {
 *       return (
 *         <div onClick={this.handleClick}>
 *           <CustomComponent ref="custom" />
 *         </div>
 *       );
 *     },
 *     handleClick: function() {
 *       this.refs.custom.handleClick();
 *     },
 *     componentDidMount: function() {
 *       this.refs.custom.initialize();
 *     }
 *   });
 *
 * Refs should rarely be used. When refs are used, they should only be done to
 * control data that is not handled by React's data flow.
 *
 * @class ReactOwner
 */
var ReactOwner = {

  /**
   * @param {?object} object
   * @return {boolean} True if `object` is a valid owner.
   * @final
   */
  isValidOwner: function(object) {
    return !!(
      object &&
      typeof object.attachRef === 'function' &&
      typeof object.detachRef === 'function'
    );
  },

  /**
   * Adds a component by ref to an owner component.
   *
   * @param {ReactComponent} component Component to reference.
   * @param {string} ref Name by which to refer to the component.
   * @param {ReactOwner} owner Component on which to record the ref.
   * @final
   * @internal
   */
  addComponentAsRefTo: function(component, ref, owner) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactOwner.isValidOwner(owner),
      'addComponentAsRefTo(...): Only a ReactOwner can have refs. This ' +
      'usually means that you\'re trying to add a ref to a component that ' +
      'doesn\'t have an owner (that is, was not created inside of another ' +
      'component\'s `render` method). Try rendering this component inside of ' +
      'a new top-level component which will hold the ref.'
    ) : invariant(ReactOwner.isValidOwner(owner)));
    owner.attachRef(ref, component);
  },

  /**
   * Removes a component by ref from an owner component.
   *
   * @param {ReactComponent} component Component to dereference.
   * @param {string} ref Name of the ref to remove.
   * @param {ReactOwner} owner Component on which the ref is recorded.
   * @final
   * @internal
   */
  removeComponentAsRefFrom: function(component, ref, owner) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReactOwner.isValidOwner(owner),
      'removeComponentAsRefFrom(...): Only a ReactOwner can have refs. This ' +
      'usually means that you\'re trying to remove a ref to a component that ' +
      'doesn\'t have an owner (that is, was not created inside of another ' +
      'component\'s `render` method). Try rendering this component inside of ' +
      'a new top-level component which will hold the ref.'
    ) : invariant(ReactOwner.isValidOwner(owner)));
    // Check that `component` is still the current ref because we do not want to
    // detach the ref if another component stole it.
    if (owner.refs[ref] === component) {
      owner.detachRef(ref);
    }
  },

  /**
   * A ReactComponent must mix this in to have refs.
   *
   * @lends {ReactOwner.prototype}
   */
  Mixin: {

    construct: function() {
      this.refs = emptyObject;
    },

    /**
     * Lazily allocates the refs object and stores `component` as `ref`.
     *
     * @param {string} ref Reference name.
     * @param {component} component Component to store as `ref`.
     * @final
     * @private
     */
    attachRef: function(ref, component) {
      ("production" !== process.env.NODE_ENV ? invariant(
        component.isOwnedBy(this),
        'attachRef(%s, ...): Only a component\'s owner can store a ref to it.',
        ref
      ) : invariant(component.isOwnedBy(this)));
      var refs = this.refs === emptyObject ? (this.refs = {}) : this.refs;
      refs[ref] = component;
    },

    /**
     * Detaches a reference name.
     *
     * @param {string} ref Name to dereference.
     * @final
     * @private
     */
    detachRef: function(ref) {
      delete this.refs[ref];
    }

  }

};

module.exports = ReactOwner;

}).call(this,require("ngpmcQ"))
},{"./emptyObject":108,"./invariant":126,"ngpmcQ":176}],68:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPerf
 * @typechecks static-only
 */

"use strict";

/**
 * ReactPerf is a general AOP system designed to measure performance. This
 * module only has the hooks: see ReactDefaultPerf for the analysis tool.
 */
var ReactPerf = {
  /**
   * Boolean to enable/disable measurement. Set to false by default to prevent
   * accidental logging and perf loss.
   */
  enableMeasure: false,

  /**
   * Holds onto the measure function in use. By default, don't measure
   * anything, but we'll override this if we inject a measure function.
   */
  storedMeasure: _noMeasure,

  /**
   * Use this to wrap methods you want to measure. Zero overhead in production.
   *
   * @param {string} objName
   * @param {string} fnName
   * @param {function} func
   * @return {function}
   */
  measure: function(objName, fnName, func) {
    if ("production" !== process.env.NODE_ENV) {
      var measuredFunc = null;
      var wrapper = function() {
        if (ReactPerf.enableMeasure) {
          if (!measuredFunc) {
            measuredFunc = ReactPerf.storedMeasure(objName, fnName, func);
          }
          return measuredFunc.apply(this, arguments);
        }
        return func.apply(this, arguments);
      };
      wrapper.displayName = objName + '_' + fnName;
      return wrapper;
    }
    return func;
  },

  injection: {
    /**
     * @param {function} measure
     */
    injectMeasure: function(measure) {
      ReactPerf.storedMeasure = measure;
    }
  }
};

/**
 * Simply passes through the measured function, without measuring it.
 *
 * @param {string} objName
 * @param {string} fnName
 * @param {function} func
 * @return {function}
 */
function _noMeasure(objName, fnName, func) {
  return func;
}

module.exports = ReactPerf;

}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],69:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTransferer
 */

"use strict";

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");
var invariant = require("./invariant");
var joinClasses = require("./joinClasses");
var warning = require("./warning");

var didWarn = false;

/**
 * Creates a transfer strategy that will merge prop values using the supplied
 * `mergeStrategy`. If a prop was previously unset, this just sets it.
 *
 * @param {function} mergeStrategy
 * @return {function}
 */
function createTransferStrategy(mergeStrategy) {
  return function(props, key, value) {
    if (!props.hasOwnProperty(key)) {
      props[key] = value;
    } else {
      props[key] = mergeStrategy(props[key], value);
    }
  };
}

var transferStrategyMerge = createTransferStrategy(function(a, b) {
  // `merge` overrides the first object's (`props[key]` above) keys using the
  // second object's (`value`) keys. An object's style's existing `propA` would
  // get overridden. Flip the order here.
  return assign({}, b, a);
});

/**
 * Transfer strategies dictate how props are transferred by `transferPropsTo`.
 * NOTE: if you add any more exceptions to this list you should be sure to
 * update `cloneWithProps()` accordingly.
 */
var TransferStrategies = {
  /**
   * Never transfer `children`.
   */
  children: emptyFunction,
  /**
   * Transfer the `className` prop by merging them.
   */
  className: createTransferStrategy(joinClasses),
  /**
   * Transfer the `style` prop (which is an object) by merging them.
   */
  style: transferStrategyMerge
};

/**
 * Mutates the first argument by transferring the properties from the second
 * argument.
 *
 * @param {object} props
 * @param {object} newProps
 * @return {object}
 */
function transferInto(props, newProps) {
  for (var thisKey in newProps) {
    if (!newProps.hasOwnProperty(thisKey)) {
      continue;
    }

    var transferStrategy = TransferStrategies[thisKey];

    if (transferStrategy && TransferStrategies.hasOwnProperty(thisKey)) {
      transferStrategy(props, thisKey, newProps[thisKey]);
    } else if (!props.hasOwnProperty(thisKey)) {
      props[thisKey] = newProps[thisKey];
    }
  }
  return props;
}

/**
 * ReactPropTransferer are capable of transferring props to another component
 * using a `transferPropsTo` method.
 *
 * @class ReactPropTransferer
 */
var ReactPropTransferer = {

  TransferStrategies: TransferStrategies,

  /**
   * Merge two props objects using TransferStrategies.
   *
   * @param {object} oldProps original props (they take precedence)
   * @param {object} newProps new props to merge in
   * @return {object} a new object containing both sets of props merged.
   */
  mergeProps: function(oldProps, newProps) {
    return transferInto(assign({}, oldProps), newProps);
  },

  /**
   * @lends {ReactPropTransferer.prototype}
   */
  Mixin: {

    /**
     * Transfer props from this component to a target component.
     *
     * Props that do not have an explicit transfer strategy will be transferred
     * only if the target component does not already have the prop set.
     *
     * This is usually used to pass down props to a returned root component.
     *
     * @param {ReactElement} element Component receiving the properties.
     * @return {ReactElement} The supplied `component`.
     * @final
     * @protected
     */
    transferPropsTo: function(element) {
      ("production" !== process.env.NODE_ENV ? invariant(
        element._owner === this,
        '%s: You can\'t call transferPropsTo() on a component that you ' +
        'don\'t own, %s. This usually means you are calling ' +
        'transferPropsTo() on a component passed in as props or children.',
        this.constructor.displayName,
        typeof element.type === 'string' ?
        element.type :
        element.type.displayName
      ) : invariant(element._owner === this));

      if ("production" !== process.env.NODE_ENV) {
        if (!didWarn) {
          didWarn = true;
          ("production" !== process.env.NODE_ENV ? warning(
            false,
            'transferPropsTo is deprecated. ' +
            'See http://fb.me/react-transferpropsto for more information.'
          ) : null);
        }
      }

      // Because elements are immutable we have to merge into the existing
      // props object rather than clone it.
      transferInto(element.props, this.props);

      return element;
    }

  }
};

module.exports = ReactPropTransferer;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./emptyFunction":107,"./invariant":126,"./joinClasses":131,"./warning":145,"ngpmcQ":176}],70:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypeLocationNames
 */

"use strict";

var ReactPropTypeLocationNames = {};

if ("production" !== process.env.NODE_ENV) {
  ReactPropTypeLocationNames = {
    prop: 'prop',
    context: 'context',
    childContext: 'child context'
  };
}

module.exports = ReactPropTypeLocationNames;

}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],71:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypeLocations
 */

"use strict";

var keyMirror = require("./keyMirror");

var ReactPropTypeLocations = keyMirror({
  prop: null,
  context: null,
  childContext: null
});

module.exports = ReactPropTypeLocations;

},{"./keyMirror":132}],72:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPropTypes
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactPropTypeLocationNames = require("./ReactPropTypeLocationNames");

var deprecated = require("./deprecated");
var emptyFunction = require("./emptyFunction");

/**
 * Collection of methods that allow declaration and validation of props that are
 * supplied to React components. Example usage:
 *
 *   var Props = require('ReactPropTypes');
 *   var MyArticle = React.createClass({
 *     propTypes: {
 *       // An optional string prop named "description".
 *       description: Props.string,
 *
 *       // A required enum prop named "category".
 *       category: Props.oneOf(['News','Photos']).isRequired,
 *
 *       // A prop named "dialog" that requires an instance of Dialog.
 *       dialog: Props.instanceOf(Dialog).isRequired
 *     },
 *     render: function() { ... }
 *   });
 *
 * A more formal specification of how these methods are used:
 *
 *   type := array|bool|func|object|number|string|oneOf([...])|instanceOf(...)
 *   decl := ReactPropTypes.{type}(.isRequired)?
 *
 * Each and every declaration produces a function with the same signature. This
 * allows the creation of custom validation functions. For example:
 *
 *  var MyLink = React.createClass({
 *    propTypes: {
 *      // An optional string or URI prop named "href".
 *      href: function(props, propName, componentName) {
 *        var propValue = props[propName];
 *        if (propValue != null && typeof propValue !== 'string' &&
 *            !(propValue instanceof URI)) {
 *          return new Error(
 *            'Expected a string or an URI for ' + propName + ' in ' +
 *            componentName
 *          );
 *        }
 *      }
 *    },
 *    render: function() {...}
 *  });
 *
 * @internal
 */

var ANONYMOUS = '<<anonymous>>';

var elementTypeChecker = createElementTypeChecker();
var nodeTypeChecker = createNodeChecker();

var ReactPropTypes = {
  array: createPrimitiveTypeChecker('array'),
  bool: createPrimitiveTypeChecker('boolean'),
  func: createPrimitiveTypeChecker('function'),
  number: createPrimitiveTypeChecker('number'),
  object: createPrimitiveTypeChecker('object'),
  string: createPrimitiveTypeChecker('string'),

  any: createAnyTypeChecker(),
  arrayOf: createArrayOfTypeChecker,
  element: elementTypeChecker,
  instanceOf: createInstanceTypeChecker,
  node: nodeTypeChecker,
  objectOf: createObjectOfTypeChecker,
  oneOf: createEnumTypeChecker,
  oneOfType: createUnionTypeChecker,
  shape: createShapeTypeChecker,

  component: deprecated(
    'React.PropTypes',
    'component',
    'element',
    this,
    elementTypeChecker
  ),
  renderable: deprecated(
    'React.PropTypes',
    'renderable',
    'node',
    this,
    nodeTypeChecker
  )
};

function createChainableTypeChecker(validate) {
  function checkType(isRequired, props, propName, componentName, location) {
    componentName = componentName || ANONYMOUS;
    if (props[propName] == null) {
      var locationName = ReactPropTypeLocationNames[location];
      if (isRequired) {
        return new Error(
          ("Required " + locationName + " `" + propName + "` was not specified in ")+
          ("`" + componentName + "`.")
        );
      }
    } else {
      return validate(props, propName, componentName, location);
    }
  }

  var chainedCheckType = checkType.bind(null, false);
  chainedCheckType.isRequired = checkType.bind(null, true);

  return chainedCheckType;
}

function createPrimitiveTypeChecker(expectedType) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== expectedType) {
      var locationName = ReactPropTypeLocationNames[location];
      // `propValue` being instance of, say, date/regexp, pass the 'object'
      // check, but we can offer a more precise error message here rather than
      // 'of type `object`'.
      var preciseType = getPreciseType(propValue);

      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type `" + preciseType + "` ") +
        ("supplied to `" + componentName + "`, expected `" + expectedType + "`.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createAnyTypeChecker() {
  return createChainableTypeChecker(emptyFunction.thatReturns());
}

function createArrayOfTypeChecker(typeChecker) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    if (!Array.isArray(propValue)) {
      var locationName = ReactPropTypeLocationNames[location];
      var propType = getPropType(propValue);
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type ") +
        ("`" + propType + "` supplied to `" + componentName + "`, expected an array.")
      );
    }
    for (var i = 0; i < propValue.length; i++) {
      var error = typeChecker(propValue, i, componentName, location);
      if (error instanceof Error) {
        return error;
      }
    }
  }
  return createChainableTypeChecker(validate);
}

function createElementTypeChecker() {
  function validate(props, propName, componentName, location) {
    if (!ReactElement.isValidElement(props[propName])) {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected a ReactElement.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createInstanceTypeChecker(expectedClass) {
  function validate(props, propName, componentName, location) {
    if (!(props[propName] instanceof expectedClass)) {
      var locationName = ReactPropTypeLocationNames[location];
      var expectedClassName = expectedClass.name || ANONYMOUS;
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected instance of `" + expectedClassName + "`.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createEnumTypeChecker(expectedValues) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    for (var i = 0; i < expectedValues.length; i++) {
      if (propValue === expectedValues[i]) {
        return;
      }
    }

    var locationName = ReactPropTypeLocationNames[location];
    var valuesString = JSON.stringify(expectedValues);
    return new Error(
      ("Invalid " + locationName + " `" + propName + "` of value `" + propValue + "` ") +
      ("supplied to `" + componentName + "`, expected one of " + valuesString + ".")
    );
  }
  return createChainableTypeChecker(validate);
}

function createObjectOfTypeChecker(typeChecker) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== 'object') {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type ") +
        ("`" + propType + "` supplied to `" + componentName + "`, expected an object.")
      );
    }
    for (var key in propValue) {
      if (propValue.hasOwnProperty(key)) {
        var error = typeChecker(propValue, key, componentName, location);
        if (error instanceof Error) {
          return error;
        }
      }
    }
  }
  return createChainableTypeChecker(validate);
}

function createUnionTypeChecker(arrayOfTypeCheckers) {
  function validate(props, propName, componentName, location) {
    for (var i = 0; i < arrayOfTypeCheckers.length; i++) {
      var checker = arrayOfTypeCheckers[i];
      if (checker(props, propName, componentName, location) == null) {
        return;
      }
    }

    var locationName = ReactPropTypeLocationNames[location];
    return new Error(
      ("Invalid " + locationName + " `" + propName + "` supplied to ") +
      ("`" + componentName + "`.")
    );
  }
  return createChainableTypeChecker(validate);
}

function createNodeChecker() {
  function validate(props, propName, componentName, location) {
    if (!isNode(props[propName])) {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` supplied to ") +
        ("`" + componentName + "`, expected a ReactNode.")
      );
    }
  }
  return createChainableTypeChecker(validate);
}

function createShapeTypeChecker(shapeTypes) {
  function validate(props, propName, componentName, location) {
    var propValue = props[propName];
    var propType = getPropType(propValue);
    if (propType !== 'object') {
      var locationName = ReactPropTypeLocationNames[location];
      return new Error(
        ("Invalid " + locationName + " `" + propName + "` of type `" + propType + "` ") +
        ("supplied to `" + componentName + "`, expected `object`.")
      );
    }
    for (var key in shapeTypes) {
      var checker = shapeTypes[key];
      if (!checker) {
        continue;
      }
      var error = checker(propValue, key, componentName, location);
      if (error) {
        return error;
      }
    }
  }
  return createChainableTypeChecker(validate, 'expected `object`');
}

function isNode(propValue) {
  switch(typeof propValue) {
    case 'number':
    case 'string':
      return true;
    case 'boolean':
      return !propValue;
    case 'object':
      if (Array.isArray(propValue)) {
        return propValue.every(isNode);
      }
      if (ReactElement.isValidElement(propValue)) {
        return true;
      }
      for (var k in propValue) {
        if (!isNode(propValue[k])) {
          return false;
        }
      }
      return true;
    default:
      return false;
  }
}

// Equivalent of `typeof` but with special handling for array and regexp.
function getPropType(propValue) {
  var propType = typeof propValue;
  if (Array.isArray(propValue)) {
    return 'array';
  }
  if (propValue instanceof RegExp) {
    // Old webkits (at least until Android 4.0) return 'function' rather than
    // 'object' for typeof a RegExp. We'll normalize this here so that /bla/
    // passes PropTypes.object.
    return 'object';
  }
  return propType;
}

// This handles more types than `getPropType`. Only used for error messages.
// See `createPrimitiveTypeChecker`.
function getPreciseType(propValue) {
  var propType = getPropType(propValue);
  if (propType === 'object') {
    if (propValue instanceof Date) {
      return 'date';
    } else if (propValue instanceof RegExp) {
      return 'regexp';
    }
  }
  return propType;
}

module.exports = ReactPropTypes;

},{"./ReactElement":52,"./ReactPropTypeLocationNames":70,"./deprecated":106,"./emptyFunction":107}],73:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactPutListenerQueue
 */

"use strict";

var PooledClass = require("./PooledClass");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");

var assign = require("./Object.assign");

function ReactPutListenerQueue() {
  this.listenersToPut = [];
}

assign(ReactPutListenerQueue.prototype, {
  enqueuePutListener: function(rootNodeID, propKey, propValue) {
    this.listenersToPut.push({
      rootNodeID: rootNodeID,
      propKey: propKey,
      propValue: propValue
    });
  },

  putListeners: function() {
    for (var i = 0; i < this.listenersToPut.length; i++) {
      var listenerToPut = this.listenersToPut[i];
      ReactBrowserEventEmitter.putListener(
        listenerToPut.rootNodeID,
        listenerToPut.propKey,
        listenerToPut.propValue
      );
    }
  },

  reset: function() {
    this.listenersToPut.length = 0;
  },

  destructor: function() {
    this.reset();
  }
});

PooledClass.addPoolingTo(ReactPutListenerQueue);

module.exports = ReactPutListenerQueue;

},{"./Object.assign":26,"./PooledClass":27,"./ReactBrowserEventEmitter":30}],74:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactReconcileTransaction
 * @typechecks static-only
 */

"use strict";

var CallbackQueue = require("./CallbackQueue");
var PooledClass = require("./PooledClass");
var ReactBrowserEventEmitter = require("./ReactBrowserEventEmitter");
var ReactInputSelection = require("./ReactInputSelection");
var ReactPutListenerQueue = require("./ReactPutListenerQueue");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");

/**
 * Ensures that, when possible, the selection range (currently selected text
 * input) is not disturbed by performing the transaction.
 */
var SELECTION_RESTORATION = {
  /**
   * @return {Selection} Selection information.
   */
  initialize: ReactInputSelection.getSelectionInformation,
  /**
   * @param {Selection} sel Selection information returned from `initialize`.
   */
  close: ReactInputSelection.restoreSelection
};

/**
 * Suppresses events (blur/focus) that could be inadvertently dispatched due to
 * high level DOM manipulations (like temporarily removing a text input from the
 * DOM).
 */
var EVENT_SUPPRESSION = {
  /**
   * @return {boolean} The enabled status of `ReactBrowserEventEmitter` before
   * the reconciliation.
   */
  initialize: function() {
    var currentlyEnabled = ReactBrowserEventEmitter.isEnabled();
    ReactBrowserEventEmitter.setEnabled(false);
    return currentlyEnabled;
  },

  /**
   * @param {boolean} previouslyEnabled Enabled status of
   *   `ReactBrowserEventEmitter` before the reconciliation occured. `close`
   *   restores the previous value.
   */
  close: function(previouslyEnabled) {
    ReactBrowserEventEmitter.setEnabled(previouslyEnabled);
  }
};

/**
 * Provides a queue for collecting `componentDidMount` and
 * `componentDidUpdate` callbacks during the the transaction.
 */
var ON_DOM_READY_QUEUEING = {
  /**
   * Initializes the internal `onDOMReady` queue.
   */
  initialize: function() {
    this.reactMountReady.reset();
  },

  /**
   * After DOM is flushed, invoke all registered `onDOMReady` callbacks.
   */
  close: function() {
    this.reactMountReady.notifyAll();
  }
};

var PUT_LISTENER_QUEUEING = {
  initialize: function() {
    this.putListenerQueue.reset();
  },

  close: function() {
    this.putListenerQueue.putListeners();
  }
};

/**
 * Executed within the scope of the `Transaction` instance. Consider these as
 * being member methods, but with an implied ordering while being isolated from
 * each other.
 */
var TRANSACTION_WRAPPERS = [
  PUT_LISTENER_QUEUEING,
  SELECTION_RESTORATION,
  EVENT_SUPPRESSION,
  ON_DOM_READY_QUEUEING
];

/**
 * Currently:
 * - The order that these are listed in the transaction is critical:
 * - Suppresses events.
 * - Restores selection range.
 *
 * Future:
 * - Restore document/overflow scroll positions that were unintentionally
 *   modified via DOM insertions above the top viewport boundary.
 * - Implement/integrate with customized constraint based layout system and keep
 *   track of which dimensions must be remeasured.
 *
 * @class ReactReconcileTransaction
 */
function ReactReconcileTransaction() {
  this.reinitializeTransaction();
  // Only server-side rendering really needs this option (see
  // `ReactServerRendering`), but server-side uses
  // `ReactServerRenderingTransaction` instead. This option is here so that it's
  // accessible and defaults to false when `ReactDOMComponent` and
  // `ReactTextComponent` checks it in `mountComponent`.`
  this.renderToStaticMarkup = false;
  this.reactMountReady = CallbackQueue.getPooled(null);
  this.putListenerQueue = ReactPutListenerQueue.getPooled();
}

var Mixin = {
  /**
   * @see Transaction
   * @abstract
   * @final
   * @return {array<object>} List of operation wrap proceedures.
   *   TODO: convert to array<TransactionWrapper>
   */
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  /**
   * @return {object} The queue to collect `onDOMReady` callbacks with.
   */
  getReactMountReady: function() {
    return this.reactMountReady;
  },

  getPutListenerQueue: function() {
    return this.putListenerQueue;
  },

  /**
   * `PooledClass` looks for this, and will invoke this before allowing this
   * instance to be resused.
   */
  destructor: function() {
    CallbackQueue.release(this.reactMountReady);
    this.reactMountReady = null;

    ReactPutListenerQueue.release(this.putListenerQueue);
    this.putListenerQueue = null;
  }
};


assign(ReactReconcileTransaction.prototype, Transaction.Mixin, Mixin);

PooledClass.addPoolingTo(ReactReconcileTransaction);

module.exports = ReactReconcileTransaction;

},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactBrowserEventEmitter":30,"./ReactInputSelection":59,"./ReactPutListenerQueue":73,"./Transaction":95}],75:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactRootIndex
 * @typechecks
 */

"use strict";

var ReactRootIndexInjection = {
  /**
   * @param {function} _createReactRootIndex
   */
  injectCreateReactRootIndex: function(_createReactRootIndex) {
    ReactRootIndex.createReactRootIndex = _createReactRootIndex;
  }
};

var ReactRootIndex = {
  createReactRootIndex: null,
  injection: ReactRootIndexInjection
};

module.exports = ReactRootIndex;

},{}],76:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @typechecks static-only
 * @providesModule ReactServerRendering
 */
"use strict";

var ReactElement = require("./ReactElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");
var ReactMarkupChecksum = require("./ReactMarkupChecksum");
var ReactServerRenderingTransaction =
  require("./ReactServerRenderingTransaction");

var instantiateReactComponent = require("./instantiateReactComponent");
var invariant = require("./invariant");

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup
 */
function renderToString(element) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(element),
    'renderToString(): You must pass a valid ReactElement.'
  ) : invariant(ReactElement.isValidElement(element)));

  var transaction;
  try {
    var id = ReactInstanceHandles.createReactRootID();
    transaction = ReactServerRenderingTransaction.getPooled(false);

    return transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      var markup = componentInstance.mountComponent(id, transaction, 0);
      return ReactMarkupChecksum.addChecksumToMarkup(markup);
    }, null);
  } finally {
    ReactServerRenderingTransaction.release(transaction);
  }
}

/**
 * @param {ReactElement} element
 * @return {string} the HTML markup, without the extra React ID and checksum
 * (for generating static pages)
 */
function renderToStaticMarkup(element) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(element),
    'renderToStaticMarkup(): You must pass a valid ReactElement.'
  ) : invariant(ReactElement.isValidElement(element)));

  var transaction;
  try {
    var id = ReactInstanceHandles.createReactRootID();
    transaction = ReactServerRenderingTransaction.getPooled(true);

    return transaction.perform(function() {
      var componentInstance = instantiateReactComponent(element, null);
      return componentInstance.mountComponent(id, transaction, 0);
    }, null);
  } finally {
    ReactServerRenderingTransaction.release(transaction);
  }
}

module.exports = {
  renderToString: renderToString,
  renderToStaticMarkup: renderToStaticMarkup
};

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./ReactInstanceHandles":60,"./ReactMarkupChecksum":62,"./ReactServerRenderingTransaction":77,"./instantiateReactComponent":125,"./invariant":126,"ngpmcQ":176}],77:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactServerRenderingTransaction
 * @typechecks
 */

"use strict";

var PooledClass = require("./PooledClass");
var CallbackQueue = require("./CallbackQueue");
var ReactPutListenerQueue = require("./ReactPutListenerQueue");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");

/**
 * Provides a `CallbackQueue` queue for collecting `onDOMReady` callbacks
 * during the performing of the transaction.
 */
var ON_DOM_READY_QUEUEING = {
  /**
   * Initializes the internal `onDOMReady` queue.
   */
  initialize: function() {
    this.reactMountReady.reset();
  },

  close: emptyFunction
};

var PUT_LISTENER_QUEUEING = {
  initialize: function() {
    this.putListenerQueue.reset();
  },

  close: emptyFunction
};

/**
 * Executed within the scope of the `Transaction` instance. Consider these as
 * being member methods, but with an implied ordering while being isolated from
 * each other.
 */
var TRANSACTION_WRAPPERS = [
  PUT_LISTENER_QUEUEING,
  ON_DOM_READY_QUEUEING
];

/**
 * @class ReactServerRenderingTransaction
 * @param {boolean} renderToStaticMarkup
 */
function ReactServerRenderingTransaction(renderToStaticMarkup) {
  this.reinitializeTransaction();
  this.renderToStaticMarkup = renderToStaticMarkup;
  this.reactMountReady = CallbackQueue.getPooled(null);
  this.putListenerQueue = ReactPutListenerQueue.getPooled();
}

var Mixin = {
  /**
   * @see Transaction
   * @abstract
   * @final
   * @return {array} Empty list of operation wrap proceedures.
   */
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  /**
   * @return {object} The queue to collect `onDOMReady` callbacks with.
   */
  getReactMountReady: function() {
    return this.reactMountReady;
  },

  getPutListenerQueue: function() {
    return this.putListenerQueue;
  },

  /**
   * `PooledClass` looks for this, and will invoke this before allowing this
   * instance to be resused.
   */
  destructor: function() {
    CallbackQueue.release(this.reactMountReady);
    this.reactMountReady = null;

    ReactPutListenerQueue.release(this.putListenerQueue);
    this.putListenerQueue = null;
  }
};


assign(
  ReactServerRenderingTransaction.prototype,
  Transaction.Mixin,
  Mixin
);

PooledClass.addPoolingTo(ReactServerRenderingTransaction);

module.exports = ReactServerRenderingTransaction;

},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactPutListenerQueue":73,"./Transaction":95,"./emptyFunction":107}],78:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactTextComponent
 * @typechecks static-only
 */

"use strict";

var DOMPropertyOperations = require("./DOMPropertyOperations");
var ReactComponent = require("./ReactComponent");
var ReactElement = require("./ReactElement");

var assign = require("./Object.assign");
var escapeTextForBrowser = require("./escapeTextForBrowser");

/**
 * Text nodes violate a couple assumptions that React makes about components:
 *
 *  - When mounting text into the DOM, adjacent text nodes are merged.
 *  - Text nodes cannot be assigned a React root ID.
 *
 * This component is used to wrap strings in elements so that they can undergo
 * the same reconciliation that is applied to elements.
 *
 * TODO: Investigate representing React components in the DOM with text nodes.
 *
 * @class ReactTextComponent
 * @extends ReactComponent
 * @internal
 */
var ReactTextComponent = function(props) {
  // This constructor and it's argument is currently used by mocks.
};

assign(ReactTextComponent.prototype, ReactComponent.Mixin, {

  /**
   * Creates the markup for this text node. This node is not intended to have
   * any features besides containing text content.
   *
   * @param {string} rootID DOM ID of the root node.
   * @param {ReactReconcileTransaction|ReactServerRenderingTransaction} transaction
   * @param {number} mountDepth number of components in the owner hierarchy
   * @return {string} Markup for this text node.
   * @internal
   */
  mountComponent: function(rootID, transaction, mountDepth) {
    ReactComponent.Mixin.mountComponent.call(
      this,
      rootID,
      transaction,
      mountDepth
    );

    var escapedText = escapeTextForBrowser(this.props);

    if (transaction.renderToStaticMarkup) {
      // Normally we'd wrap this in a `span` for the reasons stated above, but
      // since this is a situation where React won't take over (static pages),
      // we can simply return the text as it is.
      return escapedText;
    }

    return (
      '<span ' + DOMPropertyOperations.createMarkupForID(rootID) + '>' +
        escapedText +
      '</span>'
    );
  },

  /**
   * Updates this component by updating the text content.
   *
   * @param {object} nextComponent Contains the next text content.
   * @param {ReactReconcileTransaction} transaction
   * @internal
   */
  receiveComponent: function(nextComponent, transaction) {
    var nextProps = nextComponent.props;
    if (nextProps !== this.props) {
      this.props = nextProps;
      ReactComponent.BackendIDOperations.updateTextContentByID(
        this._rootNodeID,
        nextProps
      );
    }
  }

});

var ReactTextComponentFactory = function(text) {
  // Bypass validation and configuration
  return new ReactElement(ReactTextComponent, null, null, null, null, text);
};

ReactTextComponentFactory.type = ReactTextComponent;

module.exports = ReactTextComponentFactory;

},{"./DOMPropertyOperations":11,"./Object.assign":26,"./ReactComponent":32,"./ReactElement":52,"./escapeTextForBrowser":109}],79:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactUpdates
 */

"use strict";

var CallbackQueue = require("./CallbackQueue");
var PooledClass = require("./PooledClass");
var ReactCurrentOwner = require("./ReactCurrentOwner");
var ReactPerf = require("./ReactPerf");
var Transaction = require("./Transaction");

var assign = require("./Object.assign");
var invariant = require("./invariant");
var warning = require("./warning");

var dirtyComponents = [];
var asapCallbackQueue = CallbackQueue.getPooled();
var asapEnqueued = false;

var batchingStrategy = null;

function ensureInjected() {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactUpdates.ReactReconcileTransaction && batchingStrategy,
    'ReactUpdates: must inject a reconcile transaction class and batching ' +
    'strategy'
  ) : invariant(ReactUpdates.ReactReconcileTransaction && batchingStrategy));
}

var NESTED_UPDATES = {
  initialize: function() {
    this.dirtyComponentsLength = dirtyComponents.length;
  },
  close: function() {
    if (this.dirtyComponentsLength !== dirtyComponents.length) {
      // Additional updates were enqueued by componentDidUpdate handlers or
      // similar; before our own UPDATE_QUEUEING wrapper closes, we want to run
      // these new updates so that if A's componentDidUpdate calls setState on
      // B, B will update before the callback A's updater provided when calling
      // setState.
      dirtyComponents.splice(0, this.dirtyComponentsLength);
      flushBatchedUpdates();
    } else {
      dirtyComponents.length = 0;
    }
  }
};

var UPDATE_QUEUEING = {
  initialize: function() {
    this.callbackQueue.reset();
  },
  close: function() {
    this.callbackQueue.notifyAll();
  }
};

var TRANSACTION_WRAPPERS = [NESTED_UPDATES, UPDATE_QUEUEING];

function ReactUpdatesFlushTransaction() {
  this.reinitializeTransaction();
  this.dirtyComponentsLength = null;
  this.callbackQueue = CallbackQueue.getPooled();
  this.reconcileTransaction =
    ReactUpdates.ReactReconcileTransaction.getPooled();
}

assign(
  ReactUpdatesFlushTransaction.prototype,
  Transaction.Mixin, {
  getTransactionWrappers: function() {
    return TRANSACTION_WRAPPERS;
  },

  destructor: function() {
    this.dirtyComponentsLength = null;
    CallbackQueue.release(this.callbackQueue);
    this.callbackQueue = null;
    ReactUpdates.ReactReconcileTransaction.release(this.reconcileTransaction);
    this.reconcileTransaction = null;
  },

  perform: function(method, scope, a) {
    // Essentially calls `this.reconcileTransaction.perform(method, scope, a)`
    // with this transaction's wrappers around it.
    return Transaction.Mixin.perform.call(
      this,
      this.reconcileTransaction.perform,
      this.reconcileTransaction,
      method,
      scope,
      a
    );
  }
});

PooledClass.addPoolingTo(ReactUpdatesFlushTransaction);

function batchedUpdates(callback, a, b) {
  ensureInjected();
  batchingStrategy.batchedUpdates(callback, a, b);
}

/**
 * Array comparator for ReactComponents by owner depth
 *
 * @param {ReactComponent} c1 first component you're comparing
 * @param {ReactComponent} c2 second component you're comparing
 * @return {number} Return value usable by Array.prototype.sort().
 */
function mountDepthComparator(c1, c2) {
  return c1._mountDepth - c2._mountDepth;
}

function runBatchedUpdates(transaction) {
  var len = transaction.dirtyComponentsLength;
  ("production" !== process.env.NODE_ENV ? invariant(
    len === dirtyComponents.length,
    'Expected flush transaction\'s stored dirty-components length (%s) to ' +
    'match dirty-components array length (%s).',
    len,
    dirtyComponents.length
  ) : invariant(len === dirtyComponents.length));

  // Since reconciling a component higher in the owner hierarchy usually (not
  // always -- see shouldComponentUpdate()) will reconcile children, reconcile
  // them before their children by sorting the array.
  dirtyComponents.sort(mountDepthComparator);

  for (var i = 0; i < len; i++) {
    // If a component is unmounted before pending changes apply, ignore them
    // TODO: Queue unmounts in the same list to avoid this happening at all
    var component = dirtyComponents[i];
    if (component.isMounted()) {
      // If performUpdateIfNecessary happens to enqueue any new updates, we
      // shouldn't execute the callbacks until the next render happens, so
      // stash the callbacks first
      var callbacks = component._pendingCallbacks;
      component._pendingCallbacks = null;
      component.performUpdateIfNecessary(transaction.reconcileTransaction);

      if (callbacks) {
        for (var j = 0; j < callbacks.length; j++) {
          transaction.callbackQueue.enqueue(
            callbacks[j],
            component
          );
        }
      }
    }
  }
}

var flushBatchedUpdates = ReactPerf.measure(
  'ReactUpdates',
  'flushBatchedUpdates',
  function() {
    // ReactUpdatesFlushTransaction's wrappers will clear the dirtyComponents
    // array and perform any updates enqueued by mount-ready handlers (i.e.,
    // componentDidUpdate) but we need to check here too in order to catch
    // updates enqueued by setState callbacks and asap calls.
    while (dirtyComponents.length || asapEnqueued) {
      if (dirtyComponents.length) {
        var transaction = ReactUpdatesFlushTransaction.getPooled();
        transaction.perform(runBatchedUpdates, null, transaction);
        ReactUpdatesFlushTransaction.release(transaction);
      }

      if (asapEnqueued) {
        asapEnqueued = false;
        var queue = asapCallbackQueue;
        asapCallbackQueue = CallbackQueue.getPooled();
        queue.notifyAll();
        CallbackQueue.release(queue);
      }
    }
  }
);

/**
 * Mark a component as needing a rerender, adding an optional callback to a
 * list of functions which will be executed once the rerender occurs.
 */
function enqueueUpdate(component, callback) {
  ("production" !== process.env.NODE_ENV ? invariant(
    !callback || typeof callback === "function",
    'enqueueUpdate(...): You called `setProps`, `replaceProps`, ' +
    '`setState`, `replaceState`, or `forceUpdate` with a callback that ' +
    'isn\'t callable.'
  ) : invariant(!callback || typeof callback === "function"));
  ensureInjected();

  // Various parts of our code (such as ReactCompositeComponent's
  // _renderValidatedComponent) assume that calls to render aren't nested;
  // verify that that's the case. (This is called by each top-level update
  // function, like setProps, setState, forceUpdate, etc.; creation and
  // destruction of top-level components is guarded in ReactMount.)
  ("production" !== process.env.NODE_ENV ? warning(
    ReactCurrentOwner.current == null,
    'enqueueUpdate(): Render methods should be a pure function of props ' +
    'and state; triggering nested component updates from render is not ' +
    'allowed. If necessary, trigger nested updates in ' +
    'componentDidUpdate.'
  ) : null);

  if (!batchingStrategy.isBatchingUpdates) {
    batchingStrategy.batchedUpdates(enqueueUpdate, component, callback);
    return;
  }

  dirtyComponents.push(component);

  if (callback) {
    if (component._pendingCallbacks) {
      component._pendingCallbacks.push(callback);
    } else {
      component._pendingCallbacks = [callback];
    }
  }
}

/**
 * Enqueue a callback to be run at the end of the current batching cycle. Throws
 * if no updates are currently being performed.
 */
function asap(callback, context) {
  ("production" !== process.env.NODE_ENV ? invariant(
    batchingStrategy.isBatchingUpdates,
    'ReactUpdates.asap: Can\'t enqueue an asap callback in a context where' +
    'updates are not being batched.'
  ) : invariant(batchingStrategy.isBatchingUpdates));
  asapCallbackQueue.enqueue(callback, context);
  asapEnqueued = true;
}

var ReactUpdatesInjection = {
  injectReconcileTransaction: function(ReconcileTransaction) {
    ("production" !== process.env.NODE_ENV ? invariant(
      ReconcileTransaction,
      'ReactUpdates: must provide a reconcile transaction class'
    ) : invariant(ReconcileTransaction));
    ReactUpdates.ReactReconcileTransaction = ReconcileTransaction;
  },

  injectBatchingStrategy: function(_batchingStrategy) {
    ("production" !== process.env.NODE_ENV ? invariant(
      _batchingStrategy,
      'ReactUpdates: must provide a batching strategy'
    ) : invariant(_batchingStrategy));
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof _batchingStrategy.batchedUpdates === 'function',
      'ReactUpdates: must provide a batchedUpdates() function'
    ) : invariant(typeof _batchingStrategy.batchedUpdates === 'function'));
    ("production" !== process.env.NODE_ENV ? invariant(
      typeof _batchingStrategy.isBatchingUpdates === 'boolean',
      'ReactUpdates: must provide an isBatchingUpdates boolean attribute'
    ) : invariant(typeof _batchingStrategy.isBatchingUpdates === 'boolean'));
    batchingStrategy = _batchingStrategy;
  }
};

var ReactUpdates = {
  /**
   * React references `ReactReconcileTransaction` using this property in order
   * to allow dependency injection.
   *
   * @internal
   */
  ReactReconcileTransaction: null,

  batchedUpdates: batchedUpdates,
  enqueueUpdate: enqueueUpdate,
  flushBatchedUpdates: flushBatchedUpdates,
  injection: ReactUpdatesInjection,
  asap: asap
};

module.exports = ReactUpdates;

}).call(this,require("ngpmcQ"))
},{"./CallbackQueue":5,"./Object.assign":26,"./PooledClass":27,"./ReactCurrentOwner":36,"./ReactPerf":68,"./Transaction":95,"./invariant":126,"./warning":145,"ngpmcQ":176}],80:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SVGDOMPropertyConfig
 */

/*jslint bitwise: true*/

"use strict";

var DOMProperty = require("./DOMProperty");

var MUST_USE_ATTRIBUTE = DOMProperty.injection.MUST_USE_ATTRIBUTE;

var SVGDOMPropertyConfig = {
  Properties: {
    cx: MUST_USE_ATTRIBUTE,
    cy: MUST_USE_ATTRIBUTE,
    d: MUST_USE_ATTRIBUTE,
    dx: MUST_USE_ATTRIBUTE,
    dy: MUST_USE_ATTRIBUTE,
    fill: MUST_USE_ATTRIBUTE,
    fillOpacity: MUST_USE_ATTRIBUTE,
    fontFamily: MUST_USE_ATTRIBUTE,
    fontSize: MUST_USE_ATTRIBUTE,
    fx: MUST_USE_ATTRIBUTE,
    fy: MUST_USE_ATTRIBUTE,
    gradientTransform: MUST_USE_ATTRIBUTE,
    gradientUnits: MUST_USE_ATTRIBUTE,
    markerEnd: MUST_USE_ATTRIBUTE,
    markerMid: MUST_USE_ATTRIBUTE,
    markerStart: MUST_USE_ATTRIBUTE,
    offset: MUST_USE_ATTRIBUTE,
    opacity: MUST_USE_ATTRIBUTE,
    patternContentUnits: MUST_USE_ATTRIBUTE,
    patternUnits: MUST_USE_ATTRIBUTE,
    points: MUST_USE_ATTRIBUTE,
    preserveAspectRatio: MUST_USE_ATTRIBUTE,
    r: MUST_USE_ATTRIBUTE,
    rx: MUST_USE_ATTRIBUTE,
    ry: MUST_USE_ATTRIBUTE,
    spreadMethod: MUST_USE_ATTRIBUTE,
    stopColor: MUST_USE_ATTRIBUTE,
    stopOpacity: MUST_USE_ATTRIBUTE,
    stroke: MUST_USE_ATTRIBUTE,
    strokeDasharray: MUST_USE_ATTRIBUTE,
    strokeLinecap: MUST_USE_ATTRIBUTE,
    strokeOpacity: MUST_USE_ATTRIBUTE,
    strokeWidth: MUST_USE_ATTRIBUTE,
    textAnchor: MUST_USE_ATTRIBUTE,
    transform: MUST_USE_ATTRIBUTE,
    version: MUST_USE_ATTRIBUTE,
    viewBox: MUST_USE_ATTRIBUTE,
    x1: MUST_USE_ATTRIBUTE,
    x2: MUST_USE_ATTRIBUTE,
    x: MUST_USE_ATTRIBUTE,
    y1: MUST_USE_ATTRIBUTE,
    y2: MUST_USE_ATTRIBUTE,
    y: MUST_USE_ATTRIBUTE
  },
  DOMAttributeNames: {
    fillOpacity: 'fill-opacity',
    fontFamily: 'font-family',
    fontSize: 'font-size',
    gradientTransform: 'gradientTransform',
    gradientUnits: 'gradientUnits',
    markerEnd: 'marker-end',
    markerMid: 'marker-mid',
    markerStart: 'marker-start',
    patternContentUnits: 'patternContentUnits',
    patternUnits: 'patternUnits',
    preserveAspectRatio: 'preserveAspectRatio',
    spreadMethod: 'spreadMethod',
    stopColor: 'stop-color',
    stopOpacity: 'stop-opacity',
    strokeDasharray: 'stroke-dasharray',
    strokeLinecap: 'stroke-linecap',
    strokeOpacity: 'stroke-opacity',
    strokeWidth: 'stroke-width',
    textAnchor: 'text-anchor',
    viewBox: 'viewBox'
  }
};

module.exports = SVGDOMPropertyConfig;

},{"./DOMProperty":10}],81:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SelectEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPropagators = require("./EventPropagators");
var ReactInputSelection = require("./ReactInputSelection");
var SyntheticEvent = require("./SyntheticEvent");

var getActiveElement = require("./getActiveElement");
var isTextInputElement = require("./isTextInputElement");
var keyOf = require("./keyOf");
var shallowEqual = require("./shallowEqual");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  select: {
    phasedRegistrationNames: {
      bubbled: keyOf({onSelect: null}),
      captured: keyOf({onSelectCapture: null})
    },
    dependencies: [
      topLevelTypes.topBlur,
      topLevelTypes.topContextMenu,
      topLevelTypes.topFocus,
      topLevelTypes.topKeyDown,
      topLevelTypes.topMouseDown,
      topLevelTypes.topMouseUp,
      topLevelTypes.topSelectionChange
    ]
  }
};

var activeElement = null;
var activeElementID = null;
var lastSelection = null;
var mouseDown = false;

/**
 * Get an object which is a unique representation of the current selection.
 *
 * The return value will not be consistent across nodes or browsers, but
 * two identical selections on the same node will return identical objects.
 *
 * @param {DOMElement} node
 * @param {object}
 */
function getSelection(node) {
  if ('selectionStart' in node &&
      ReactInputSelection.hasSelectionCapabilities(node)) {
    return {
      start: node.selectionStart,
      end: node.selectionEnd
    };
  } else if (window.getSelection) {
    var selection = window.getSelection();
    return {
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset
    };
  } else if (document.selection) {
    var range = document.selection.createRange();
    return {
      parentElement: range.parentElement(),
      text: range.text,
      top: range.boundingTop,
      left: range.boundingLeft
    };
  }
}

/**
 * Poll selection to see whether it's changed.
 *
 * @param {object} nativeEvent
 * @return {?SyntheticEvent}
 */
function constructSelectEvent(nativeEvent) {
  // Ensure we have the right element, and that the user is not dragging a
  // selection (this matches native `select` event behavior). In HTML5, select
  // fires only on input and textarea thus if there's no focused element we
  // won't dispatch.
  if (mouseDown ||
      activeElement == null ||
      activeElement != getActiveElement()) {
    return;
  }

  // Only fire when selection has actually changed.
  var currentSelection = getSelection(activeElement);
  if (!lastSelection || !shallowEqual(lastSelection, currentSelection)) {
    lastSelection = currentSelection;

    var syntheticEvent = SyntheticEvent.getPooled(
      eventTypes.select,
      activeElementID,
      nativeEvent
    );

    syntheticEvent.type = 'select';
    syntheticEvent.target = activeElement;

    EventPropagators.accumulateTwoPhaseDispatches(syntheticEvent);

    return syntheticEvent;
  }
}

/**
 * This plugin creates an `onSelect` event that normalizes select events
 * across form elements.
 *
 * Supported elements are:
 * - input (see `isTextInputElement`)
 * - textarea
 * - contentEditable
 *
 * This differs from native browser implementations in the following ways:
 * - Fires on contentEditable fields as well as inputs.
 * - Fires for collapsed selection.
 * - Fires after user input.
 */
var SelectEventPlugin = {

  eventTypes: eventTypes,

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {

    switch (topLevelType) {
      // Track the input node that has focus.
      case topLevelTypes.topFocus:
        if (isTextInputElement(topLevelTarget) ||
            topLevelTarget.contentEditable === 'true') {
          activeElement = topLevelTarget;
          activeElementID = topLevelTargetID;
          lastSelection = null;
        }
        break;
      case topLevelTypes.topBlur:
        activeElement = null;
        activeElementID = null;
        lastSelection = null;
        break;

      // Don't fire the event while the user is dragging. This matches the
      // semantics of the native select event.
      case topLevelTypes.topMouseDown:
        mouseDown = true;
        break;
      case topLevelTypes.topContextMenu:
      case topLevelTypes.topMouseUp:
        mouseDown = false;
        return constructSelectEvent(nativeEvent);

      // Chrome and IE fire non-standard event when selection is changed (and
      // sometimes when it hasn't).
      // Firefox doesn't support selectionchange, so check selection status
      // after each key entry. The selection changes after keydown and before
      // keyup, but we check on keydown as well in the case of holding down a
      // key, when multiple keydown events are fired but only one keyup is.
      case topLevelTypes.topSelectionChange:
      case topLevelTypes.topKeyDown:
      case topLevelTypes.topKeyUp:
        return constructSelectEvent(nativeEvent);
    }
  }
};

module.exports = SelectEventPlugin;

},{"./EventConstants":15,"./EventPropagators":20,"./ReactInputSelection":59,"./SyntheticEvent":87,"./getActiveElement":113,"./isTextInputElement":129,"./keyOf":133,"./shallowEqual":141}],82:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ServerReactRootIndex
 * @typechecks
 */

"use strict";

/**
 * Size of the reactRoot ID space. We generate random numbers for React root
 * IDs and if there's a collision the events and DOM update system will
 * get confused. In the future we need a way to generate GUIDs but for
 * now this will work on a smaller scale.
 */
var GLOBAL_MOUNT_POINT_MAX = Math.pow(2, 53);

var ServerReactRootIndex = {
  createReactRootIndex: function() {
    return Math.ceil(Math.random() * GLOBAL_MOUNT_POINT_MAX);
  }
};

module.exports = ServerReactRootIndex;

},{}],83:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SimpleEventPlugin
 */

"use strict";

var EventConstants = require("./EventConstants");
var EventPluginUtils = require("./EventPluginUtils");
var EventPropagators = require("./EventPropagators");
var SyntheticClipboardEvent = require("./SyntheticClipboardEvent");
var SyntheticEvent = require("./SyntheticEvent");
var SyntheticFocusEvent = require("./SyntheticFocusEvent");
var SyntheticKeyboardEvent = require("./SyntheticKeyboardEvent");
var SyntheticMouseEvent = require("./SyntheticMouseEvent");
var SyntheticDragEvent = require("./SyntheticDragEvent");
var SyntheticTouchEvent = require("./SyntheticTouchEvent");
var SyntheticUIEvent = require("./SyntheticUIEvent");
var SyntheticWheelEvent = require("./SyntheticWheelEvent");

var getEventCharCode = require("./getEventCharCode");

var invariant = require("./invariant");
var keyOf = require("./keyOf");
var warning = require("./warning");

var topLevelTypes = EventConstants.topLevelTypes;

var eventTypes = {
  blur: {
    phasedRegistrationNames: {
      bubbled: keyOf({onBlur: true}),
      captured: keyOf({onBlurCapture: true})
    }
  },
  click: {
    phasedRegistrationNames: {
      bubbled: keyOf({onClick: true}),
      captured: keyOf({onClickCapture: true})
    }
  },
  contextMenu: {
    phasedRegistrationNames: {
      bubbled: keyOf({onContextMenu: true}),
      captured: keyOf({onContextMenuCapture: true})
    }
  },
  copy: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCopy: true}),
      captured: keyOf({onCopyCapture: true})
    }
  },
  cut: {
    phasedRegistrationNames: {
      bubbled: keyOf({onCut: true}),
      captured: keyOf({onCutCapture: true})
    }
  },
  doubleClick: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDoubleClick: true}),
      captured: keyOf({onDoubleClickCapture: true})
    }
  },
  drag: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDrag: true}),
      captured: keyOf({onDragCapture: true})
    }
  },
  dragEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragEnd: true}),
      captured: keyOf({onDragEndCapture: true})
    }
  },
  dragEnter: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragEnter: true}),
      captured: keyOf({onDragEnterCapture: true})
    }
  },
  dragExit: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragExit: true}),
      captured: keyOf({onDragExitCapture: true})
    }
  },
  dragLeave: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragLeave: true}),
      captured: keyOf({onDragLeaveCapture: true})
    }
  },
  dragOver: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragOver: true}),
      captured: keyOf({onDragOverCapture: true})
    }
  },
  dragStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDragStart: true}),
      captured: keyOf({onDragStartCapture: true})
    }
  },
  drop: {
    phasedRegistrationNames: {
      bubbled: keyOf({onDrop: true}),
      captured: keyOf({onDropCapture: true})
    }
  },
  focus: {
    phasedRegistrationNames: {
      bubbled: keyOf({onFocus: true}),
      captured: keyOf({onFocusCapture: true})
    }
  },
  input: {
    phasedRegistrationNames: {
      bubbled: keyOf({onInput: true}),
      captured: keyOf({onInputCapture: true})
    }
  },
  keyDown: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyDown: true}),
      captured: keyOf({onKeyDownCapture: true})
    }
  },
  keyPress: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyPress: true}),
      captured: keyOf({onKeyPressCapture: true})
    }
  },
  keyUp: {
    phasedRegistrationNames: {
      bubbled: keyOf({onKeyUp: true}),
      captured: keyOf({onKeyUpCapture: true})
    }
  },
  load: {
    phasedRegistrationNames: {
      bubbled: keyOf({onLoad: true}),
      captured: keyOf({onLoadCapture: true})
    }
  },
  error: {
    phasedRegistrationNames: {
      bubbled: keyOf({onError: true}),
      captured: keyOf({onErrorCapture: true})
    }
  },
  // Note: We do not allow listening to mouseOver events. Instead, use the
  // onMouseEnter/onMouseLeave created by `EnterLeaveEventPlugin`.
  mouseDown: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseDown: true}),
      captured: keyOf({onMouseDownCapture: true})
    }
  },
  mouseMove: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseMove: true}),
      captured: keyOf({onMouseMoveCapture: true})
    }
  },
  mouseOut: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseOut: true}),
      captured: keyOf({onMouseOutCapture: true})
    }
  },
  mouseOver: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseOver: true}),
      captured: keyOf({onMouseOverCapture: true})
    }
  },
  mouseUp: {
    phasedRegistrationNames: {
      bubbled: keyOf({onMouseUp: true}),
      captured: keyOf({onMouseUpCapture: true})
    }
  },
  paste: {
    phasedRegistrationNames: {
      bubbled: keyOf({onPaste: true}),
      captured: keyOf({onPasteCapture: true})
    }
  },
  reset: {
    phasedRegistrationNames: {
      bubbled: keyOf({onReset: true}),
      captured: keyOf({onResetCapture: true})
    }
  },
  scroll: {
    phasedRegistrationNames: {
      bubbled: keyOf({onScroll: true}),
      captured: keyOf({onScrollCapture: true})
    }
  },
  submit: {
    phasedRegistrationNames: {
      bubbled: keyOf({onSubmit: true}),
      captured: keyOf({onSubmitCapture: true})
    }
  },
  touchCancel: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchCancel: true}),
      captured: keyOf({onTouchCancelCapture: true})
    }
  },
  touchEnd: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchEnd: true}),
      captured: keyOf({onTouchEndCapture: true})
    }
  },
  touchMove: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchMove: true}),
      captured: keyOf({onTouchMoveCapture: true})
    }
  },
  touchStart: {
    phasedRegistrationNames: {
      bubbled: keyOf({onTouchStart: true}),
      captured: keyOf({onTouchStartCapture: true})
    }
  },
  wheel: {
    phasedRegistrationNames: {
      bubbled: keyOf({onWheel: true}),
      captured: keyOf({onWheelCapture: true})
    }
  }
};

var topLevelEventsToDispatchConfig = {
  topBlur:        eventTypes.blur,
  topClick:       eventTypes.click,
  topContextMenu: eventTypes.contextMenu,
  topCopy:        eventTypes.copy,
  topCut:         eventTypes.cut,
  topDoubleClick: eventTypes.doubleClick,
  topDrag:        eventTypes.drag,
  topDragEnd:     eventTypes.dragEnd,
  topDragEnter:   eventTypes.dragEnter,
  topDragExit:    eventTypes.dragExit,
  topDragLeave:   eventTypes.dragLeave,
  topDragOver:    eventTypes.dragOver,
  topDragStart:   eventTypes.dragStart,
  topDrop:        eventTypes.drop,
  topError:       eventTypes.error,
  topFocus:       eventTypes.focus,
  topInput:       eventTypes.input,
  topKeyDown:     eventTypes.keyDown,
  topKeyPress:    eventTypes.keyPress,
  topKeyUp:       eventTypes.keyUp,
  topLoad:        eventTypes.load,
  topMouseDown:   eventTypes.mouseDown,
  topMouseMove:   eventTypes.mouseMove,
  topMouseOut:    eventTypes.mouseOut,
  topMouseOver:   eventTypes.mouseOver,
  topMouseUp:     eventTypes.mouseUp,
  topPaste:       eventTypes.paste,
  topReset:       eventTypes.reset,
  topScroll:      eventTypes.scroll,
  topSubmit:      eventTypes.submit,
  topTouchCancel: eventTypes.touchCancel,
  topTouchEnd:    eventTypes.touchEnd,
  topTouchMove:   eventTypes.touchMove,
  topTouchStart:  eventTypes.touchStart,
  topWheel:       eventTypes.wheel
};

for (var topLevelType in topLevelEventsToDispatchConfig) {
  topLevelEventsToDispatchConfig[topLevelType].dependencies = [topLevelType];
}

var SimpleEventPlugin = {

  eventTypes: eventTypes,

  /**
   * Same as the default implementation, except cancels the event when return
   * value is false. This behavior will be disabled in a future release.
   *
   * @param {object} Event to be dispatched.
   * @param {function} Application-level callback.
   * @param {string} domID DOM ID to pass to the callback.
   */
  executeDispatch: function(event, listener, domID) {
    var returnValue = EventPluginUtils.executeDispatch(event, listener, domID);

    ("production" !== process.env.NODE_ENV ? warning(
      typeof returnValue !== 'boolean',
      'Returning `false` from an event handler is deprecated and will be ' +
      'ignored in a future release. Instead, manually call ' +
      'e.stopPropagation() or e.preventDefault(), as appropriate.'
    ) : null);

    if (returnValue === false) {
      event.stopPropagation();
      event.preventDefault();
    }
  },

  /**
   * @param {string} topLevelType Record from `EventConstants`.
   * @param {DOMEventTarget} topLevelTarget The listening component root node.
   * @param {string} topLevelTargetID ID of `topLevelTarget`.
   * @param {object} nativeEvent Native browser event.
   * @return {*} An accumulation of synthetic events.
   * @see {EventPluginHub.extractEvents}
   */
  extractEvents: function(
      topLevelType,
      topLevelTarget,
      topLevelTargetID,
      nativeEvent) {
    var dispatchConfig = topLevelEventsToDispatchConfig[topLevelType];
    if (!dispatchConfig) {
      return null;
    }
    var EventConstructor;
    switch (topLevelType) {
      case topLevelTypes.topInput:
      case topLevelTypes.topLoad:
      case topLevelTypes.topError:
      case topLevelTypes.topReset:
      case topLevelTypes.topSubmit:
        // HTML Events
        // @see http://www.w3.org/TR/html5/index.html#events-0
        EventConstructor = SyntheticEvent;
        break;
      case topLevelTypes.topKeyPress:
        // FireFox creates a keypress event for function keys too. This removes
        // the unwanted keypress events. Enter is however both printable and
        // non-printable. One would expect Tab to be as well (but it isn't).
        if (getEventCharCode(nativeEvent) === 0) {
          return null;
        }
        /* falls through */
      case topLevelTypes.topKeyDown:
      case topLevelTypes.topKeyUp:
        EventConstructor = SyntheticKeyboardEvent;
        break;
      case topLevelTypes.topBlur:
      case topLevelTypes.topFocus:
        EventConstructor = SyntheticFocusEvent;
        break;
      case topLevelTypes.topClick:
        // Firefox creates a click event on right mouse clicks. This removes the
        // unwanted click events.
        if (nativeEvent.button === 2) {
          return null;
        }
        /* falls through */
      case topLevelTypes.topContextMenu:
      case topLevelTypes.topDoubleClick:
      case topLevelTypes.topMouseDown:
      case topLevelTypes.topMouseMove:
      case topLevelTypes.topMouseOut:
      case topLevelTypes.topMouseOver:
      case topLevelTypes.topMouseUp:
        EventConstructor = SyntheticMouseEvent;
        break;
      case topLevelTypes.topDrag:
      case topLevelTypes.topDragEnd:
      case topLevelTypes.topDragEnter:
      case topLevelTypes.topDragExit:
      case topLevelTypes.topDragLeave:
      case topLevelTypes.topDragOver:
      case topLevelTypes.topDragStart:
      case topLevelTypes.topDrop:
        EventConstructor = SyntheticDragEvent;
        break;
      case topLevelTypes.topTouchCancel:
      case topLevelTypes.topTouchEnd:
      case topLevelTypes.topTouchMove:
      case topLevelTypes.topTouchStart:
        EventConstructor = SyntheticTouchEvent;
        break;
      case topLevelTypes.topScroll:
        EventConstructor = SyntheticUIEvent;
        break;
      case topLevelTypes.topWheel:
        EventConstructor = SyntheticWheelEvent;
        break;
      case topLevelTypes.topCopy:
      case topLevelTypes.topCut:
      case topLevelTypes.topPaste:
        EventConstructor = SyntheticClipboardEvent;
        break;
    }
    ("production" !== process.env.NODE_ENV ? invariant(
      EventConstructor,
      'SimpleEventPlugin: Unhandled event type, `%s`.',
      topLevelType
    ) : invariant(EventConstructor));
    var event = EventConstructor.getPooled(
      dispatchConfig,
      topLevelTargetID,
      nativeEvent
    );
    EventPropagators.accumulateTwoPhaseDispatches(event);
    return event;
  }

};

module.exports = SimpleEventPlugin;

}).call(this,require("ngpmcQ"))
},{"./EventConstants":15,"./EventPluginUtils":19,"./EventPropagators":20,"./SyntheticClipboardEvent":84,"./SyntheticDragEvent":86,"./SyntheticEvent":87,"./SyntheticFocusEvent":88,"./SyntheticKeyboardEvent":90,"./SyntheticMouseEvent":91,"./SyntheticTouchEvent":92,"./SyntheticUIEvent":93,"./SyntheticWheelEvent":94,"./getEventCharCode":114,"./invariant":126,"./keyOf":133,"./warning":145,"ngpmcQ":176}],84:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticClipboardEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/clipboard-apis/
 */
var ClipboardEventInterface = {
  clipboardData: function(event) {
    return (
      'clipboardData' in event ?
        event.clipboardData :
        window.clipboardData
    );
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticClipboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(SyntheticClipboardEvent, ClipboardEventInterface);

module.exports = SyntheticClipboardEvent;


},{"./SyntheticEvent":87}],85:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticCompositionEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/DOM-Level-3-Events/#events-compositionevents
 */
var CompositionEventInterface = {
  data: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticCompositionEvent(
  dispatchConfig,
  dispatchMarker,
  nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(
  SyntheticCompositionEvent,
  CompositionEventInterface
);

module.exports = SyntheticCompositionEvent;


},{"./SyntheticEvent":87}],86:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticDragEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticMouseEvent = require("./SyntheticMouseEvent");

/**
 * @interface DragEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var DragEventInterface = {
  dataTransfer: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticDragEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticMouseEvent.augmentClass(SyntheticDragEvent, DragEventInterface);

module.exports = SyntheticDragEvent;

},{"./SyntheticMouseEvent":91}],87:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticEvent
 * @typechecks static-only
 */

"use strict";

var PooledClass = require("./PooledClass");

var assign = require("./Object.assign");
var emptyFunction = require("./emptyFunction");
var getEventTarget = require("./getEventTarget");

/**
 * @interface Event
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var EventInterface = {
  type: null,
  target: getEventTarget,
  // currentTarget is set when dispatching; no use in copying it here
  currentTarget: emptyFunction.thatReturnsNull,
  eventPhase: null,
  bubbles: null,
  cancelable: null,
  timeStamp: function(event) {
    return event.timeStamp || Date.now();
  },
  defaultPrevented: null,
  isTrusted: null
};

/**
 * Synthetic events are dispatched by event plugins, typically in response to a
 * top-level event delegation handler.
 *
 * These systems should generally use pooling to reduce the frequency of garbage
 * collection. The system should check `isPersistent` to determine whether the
 * event should be released into the pool after being dispatched. Users that
 * need a persisted event should invoke `persist`.
 *
 * Synthetic events (and subclasses) implement the DOM Level 3 Events API by
 * normalizing browser quirks. Subclasses do not necessarily have to implement a
 * DOM interface; custom application-specific events can also subclass this.
 *
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 */
function SyntheticEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  this.dispatchConfig = dispatchConfig;
  this.dispatchMarker = dispatchMarker;
  this.nativeEvent = nativeEvent;

  var Interface = this.constructor.Interface;
  for (var propName in Interface) {
    if (!Interface.hasOwnProperty(propName)) {
      continue;
    }
    var normalize = Interface[propName];
    if (normalize) {
      this[propName] = normalize(nativeEvent);
    } else {
      this[propName] = nativeEvent[propName];
    }
  }

  var defaultPrevented = nativeEvent.defaultPrevented != null ?
    nativeEvent.defaultPrevented :
    nativeEvent.returnValue === false;
  if (defaultPrevented) {
    this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
  } else {
    this.isDefaultPrevented = emptyFunction.thatReturnsFalse;
  }
  this.isPropagationStopped = emptyFunction.thatReturnsFalse;
}

assign(SyntheticEvent.prototype, {

  preventDefault: function() {
    this.defaultPrevented = true;
    var event = this.nativeEvent;
    event.preventDefault ? event.preventDefault() : event.returnValue = false;
    this.isDefaultPrevented = emptyFunction.thatReturnsTrue;
  },

  stopPropagation: function() {
    var event = this.nativeEvent;
    event.stopPropagation ? event.stopPropagation() : event.cancelBubble = true;
    this.isPropagationStopped = emptyFunction.thatReturnsTrue;
  },

  /**
   * We release all dispatched `SyntheticEvent`s after each event loop, adding
   * them back into the pool. This allows a way to hold onto a reference that
   * won't be added back into the pool.
   */
  persist: function() {
    this.isPersistent = emptyFunction.thatReturnsTrue;
  },

  /**
   * Checks if this event should be released back into the pool.
   *
   * @return {boolean} True if this should not be released, false otherwise.
   */
  isPersistent: emptyFunction.thatReturnsFalse,

  /**
   * `PooledClass` looks for `destructor` on each instance it releases.
   */
  destructor: function() {
    var Interface = this.constructor.Interface;
    for (var propName in Interface) {
      this[propName] = null;
    }
    this.dispatchConfig = null;
    this.dispatchMarker = null;
    this.nativeEvent = null;
  }

});

SyntheticEvent.Interface = EventInterface;

/**
 * Helper to reduce boilerplate when creating subclasses.
 *
 * @param {function} Class
 * @param {?object} Interface
 */
SyntheticEvent.augmentClass = function(Class, Interface) {
  var Super = this;

  var prototype = Object.create(Super.prototype);
  assign(prototype, Class.prototype);
  Class.prototype = prototype;
  Class.prototype.constructor = Class;

  Class.Interface = assign({}, Super.Interface, Interface);
  Class.augmentClass = Super.augmentClass;

  PooledClass.addPoolingTo(Class, PooledClass.threeArgumentPooler);
};

PooledClass.addPoolingTo(SyntheticEvent, PooledClass.threeArgumentPooler);

module.exports = SyntheticEvent;

},{"./Object.assign":26,"./PooledClass":27,"./emptyFunction":107,"./getEventTarget":117}],88:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticFocusEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

/**
 * @interface FocusEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var FocusEventInterface = {
  relatedTarget: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticFocusEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticFocusEvent, FocusEventInterface);

module.exports = SyntheticFocusEvent;

},{"./SyntheticUIEvent":93}],89:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticInputEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

/**
 * @interface Event
 * @see http://www.w3.org/TR/2013/WD-DOM-Level-3-Events-20131105
 *      /#events-inputevents
 */
var InputEventInterface = {
  data: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticInputEvent(
  dispatchConfig,
  dispatchMarker,
  nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(
  SyntheticInputEvent,
  InputEventInterface
);

module.exports = SyntheticInputEvent;


},{"./SyntheticEvent":87}],90:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticKeyboardEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

var getEventCharCode = require("./getEventCharCode");
var getEventKey = require("./getEventKey");
var getEventModifierState = require("./getEventModifierState");

/**
 * @interface KeyboardEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var KeyboardEventInterface = {
  key: getEventKey,
  location: null,
  ctrlKey: null,
  shiftKey: null,
  altKey: null,
  metaKey: null,
  repeat: null,
  locale: null,
  getModifierState: getEventModifierState,
  // Legacy Interface
  charCode: function(event) {
    // `charCode` is the result of a KeyPress event and represents the value of
    // the actual printable character.

    // KeyPress is deprecated, but its replacement is not yet final and not
    // implemented in any major browser. Only KeyPress has charCode.
    if (event.type === 'keypress') {
      return getEventCharCode(event);
    }
    return 0;
  },
  keyCode: function(event) {
    // `keyCode` is the result of a KeyDown/Up event and represents the value of
    // physical keyboard key.

    // The actual meaning of the value depends on the users' keyboard layout
    // which cannot be detected. Assuming that it is a US keyboard layout
    // provides a surprisingly accurate mapping for US and European users.
    // Due to this, it is left to the user to implement at this time.
    if (event.type === 'keydown' || event.type === 'keyup') {
      return event.keyCode;
    }
    return 0;
  },
  which: function(event) {
    // `which` is an alias for either `keyCode` or `charCode` depending on the
    // type of the event.
    if (event.type === 'keypress') {
      return getEventCharCode(event);
    }
    if (event.type === 'keydown' || event.type === 'keyup') {
      return event.keyCode;
    }
    return 0;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticKeyboardEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticKeyboardEvent, KeyboardEventInterface);

module.exports = SyntheticKeyboardEvent;

},{"./SyntheticUIEvent":93,"./getEventCharCode":114,"./getEventKey":115,"./getEventModifierState":116}],91:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticMouseEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");
var ViewportMetrics = require("./ViewportMetrics");

var getEventModifierState = require("./getEventModifierState");

/**
 * @interface MouseEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var MouseEventInterface = {
  screenX: null,
  screenY: null,
  clientX: null,
  clientY: null,
  ctrlKey: null,
  shiftKey: null,
  altKey: null,
  metaKey: null,
  getModifierState: getEventModifierState,
  button: function(event) {
    // Webkit, Firefox, IE9+
    // which:  1 2 3
    // button: 0 1 2 (standard)
    var button = event.button;
    if ('which' in event) {
      return button;
    }
    // IE<9
    // which:  undefined
    // button: 0 0 0
    // button: 1 4 2 (onmouseup)
    return button === 2 ? 2 : button === 4 ? 1 : 0;
  },
  buttons: null,
  relatedTarget: function(event) {
    return event.relatedTarget || (
      event.fromElement === event.srcElement ?
        event.toElement :
        event.fromElement
    );
  },
  // "Proprietary" Interface.
  pageX: function(event) {
    return 'pageX' in event ?
      event.pageX :
      event.clientX + ViewportMetrics.currentScrollLeft;
  },
  pageY: function(event) {
    return 'pageY' in event ?
      event.pageY :
      event.clientY + ViewportMetrics.currentScrollTop;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticMouseEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticMouseEvent, MouseEventInterface);

module.exports = SyntheticMouseEvent;

},{"./SyntheticUIEvent":93,"./ViewportMetrics":96,"./getEventModifierState":116}],92:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticTouchEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticUIEvent = require("./SyntheticUIEvent");

var getEventModifierState = require("./getEventModifierState");

/**
 * @interface TouchEvent
 * @see http://www.w3.org/TR/touch-events/
 */
var TouchEventInterface = {
  touches: null,
  targetTouches: null,
  changedTouches: null,
  altKey: null,
  metaKey: null,
  ctrlKey: null,
  shiftKey: null,
  getModifierState: getEventModifierState
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticUIEvent}
 */
function SyntheticTouchEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticUIEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticUIEvent.augmentClass(SyntheticTouchEvent, TouchEventInterface);

module.exports = SyntheticTouchEvent;

},{"./SyntheticUIEvent":93,"./getEventModifierState":116}],93:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticUIEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticEvent = require("./SyntheticEvent");

var getEventTarget = require("./getEventTarget");

/**
 * @interface UIEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var UIEventInterface = {
  view: function(event) {
    if (event.view) {
      return event.view;
    }

    var target = getEventTarget(event);
    if (target != null && target.window === target) {
      // target is a window object
      return target;
    }

    var doc = target.ownerDocument;
    // TODO: Figure out why `ownerDocument` is sometimes undefined in IE8.
    if (doc) {
      return doc.defaultView || doc.parentWindow;
    } else {
      return window;
    }
  },
  detail: function(event) {
    return event.detail || 0;
  }
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticEvent}
 */
function SyntheticUIEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticEvent.augmentClass(SyntheticUIEvent, UIEventInterface);

module.exports = SyntheticUIEvent;

},{"./SyntheticEvent":87,"./getEventTarget":117}],94:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule SyntheticWheelEvent
 * @typechecks static-only
 */

"use strict";

var SyntheticMouseEvent = require("./SyntheticMouseEvent");

/**
 * @interface WheelEvent
 * @see http://www.w3.org/TR/DOM-Level-3-Events/
 */
var WheelEventInterface = {
  deltaX: function(event) {
    return (
      'deltaX' in event ? event.deltaX :
      // Fallback to `wheelDeltaX` for Webkit and normalize (right is positive).
      'wheelDeltaX' in event ? -event.wheelDeltaX : 0
    );
  },
  deltaY: function(event) {
    return (
      'deltaY' in event ? event.deltaY :
      // Fallback to `wheelDeltaY` for Webkit and normalize (down is positive).
      'wheelDeltaY' in event ? -event.wheelDeltaY :
      // Fallback to `wheelDelta` for IE<9 and normalize (down is positive).
      'wheelDelta' in event ? -event.wheelDelta : 0
    );
  },
  deltaZ: null,

  // Browsers without "deltaMode" is reporting in raw wheel delta where one
  // notch on the scroll is always +/- 120, roughly equivalent to pixels.
  // A good approximation of DOM_DELTA_LINE (1) is 5% of viewport size or
  // ~40 pixels, for DOM_DELTA_SCREEN (2) it is 87.5% of viewport size.
  deltaMode: null
};

/**
 * @param {object} dispatchConfig Configuration used to dispatch this event.
 * @param {string} dispatchMarker Marker identifying the event target.
 * @param {object} nativeEvent Native browser event.
 * @extends {SyntheticMouseEvent}
 */
function SyntheticWheelEvent(dispatchConfig, dispatchMarker, nativeEvent) {
  SyntheticMouseEvent.call(this, dispatchConfig, dispatchMarker, nativeEvent);
}

SyntheticMouseEvent.augmentClass(SyntheticWheelEvent, WheelEventInterface);

module.exports = SyntheticWheelEvent;

},{"./SyntheticMouseEvent":91}],95:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Transaction
 */

"use strict";

var invariant = require("./invariant");

/**
 * `Transaction` creates a black box that is able to wrap any method such that
 * certain invariants are maintained before and after the method is invoked
 * (Even if an exception is thrown while invoking the wrapped method). Whoever
 * instantiates a transaction can provide enforcers of the invariants at
 * creation time. The `Transaction` class itself will supply one additional
 * automatic invariant for you - the invariant that any transaction instance
 * should not be run while it is already being run. You would typically create a
 * single instance of a `Transaction` for reuse multiple times, that potentially
 * is used to wrap several different methods. Wrappers are extremely simple -
 * they only require implementing two methods.
 *
 * <pre>
 *                       wrappers (injected at creation time)
 *                                      +        +
 *                                      |        |
 *                    +-----------------|--------|--------------+
 *                    |                 v        |              |
 *                    |      +---------------+   |              |
 *                    |   +--|    wrapper1   |---|----+         |
 *                    |   |  +---------------+   v    |         |
 *                    |   |          +-------------+  |         |
 *                    |   |     +----|   wrapper2  |--------+   |
 *                    |   |     |    +-------------+  |     |   |
 *                    |   |     |                     |     |   |
 *                    |   v     v                     v     v   | wrapper
 *                    | +---+ +---+   +---------+   +---+ +---+ | invariants
 * perform(anyMethod) | |   | |   |   |         |   |   | |   | | maintained
 * +----------------->|-|---|-|---|-->|anyMethod|---|---|-|---|-|-------->
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | |   | |   |   |         |   |   | |   | |
 *                    | +---+ +---+   +---------+   +---+ +---+ |
 *                    |  initialize                    close    |
 *                    +-----------------------------------------+
 * </pre>
 *
 * Use cases:
 * - Preserving the input selection ranges before/after reconciliation.
 *   Restoring selection even in the event of an unexpected error.
 * - Deactivating events while rearranging the DOM, preventing blurs/focuses,
 *   while guaranteeing that afterwards, the event system is reactivated.
 * - Flushing a queue of collected DOM mutations to the main UI thread after a
 *   reconciliation takes place in a worker thread.
 * - Invoking any collected `componentDidUpdate` callbacks after rendering new
 *   content.
 * - (Future use case): Wrapping particular flushes of the `ReactWorker` queue
 *   to preserve the `scrollTop` (an automatic scroll aware DOM).
 * - (Future use case): Layout calculations before and after DOM upates.
 *
 * Transactional plugin API:
 * - A module that has an `initialize` method that returns any precomputation.
 * - and a `close` method that accepts the precomputation. `close` is invoked
 *   when the wrapped process is completed, or has failed.
 *
 * @param {Array<TransactionalWrapper>} transactionWrapper Wrapper modules
 * that implement `initialize` and `close`.
 * @return {Transaction} Single transaction for reuse in thread.
 *
 * @class Transaction
 */
var Mixin = {
  /**
   * Sets up this instance so that it is prepared for collecting metrics. Does
   * so such that this setup method may be used on an instance that is already
   * initialized, in a way that does not consume additional memory upon reuse.
   * That can be useful if you decide to make your subclass of this mixin a
   * "PooledClass".
   */
  reinitializeTransaction: function() {
    this.transactionWrappers = this.getTransactionWrappers();
    if (!this.wrapperInitData) {
      this.wrapperInitData = [];
    } else {
      this.wrapperInitData.length = 0;
    }
    this._isInTransaction = false;
  },

  _isInTransaction: false,

  /**
   * @abstract
   * @return {Array<TransactionWrapper>} Array of transaction wrappers.
   */
  getTransactionWrappers: null,

  isInTransaction: function() {
    return !!this._isInTransaction;
  },

  /**
   * Executes the function within a safety window. Use this for the top level
   * methods that result in large amounts of computation/mutations that would
   * need to be safety checked.
   *
   * @param {function} method Member of scope to call.
   * @param {Object} scope Scope to invoke from.
   * @param {Object?=} args... Arguments to pass to the method (optional).
   *                           Helps prevent need to bind in many cases.
   * @return Return value from `method`.
   */
  perform: function(method, scope, a, b, c, d, e, f) {
    ("production" !== process.env.NODE_ENV ? invariant(
      !this.isInTransaction(),
      'Transaction.perform(...): Cannot initialize a transaction when there ' +
      'is already an outstanding transaction.'
    ) : invariant(!this.isInTransaction()));
    var errorThrown;
    var ret;
    try {
      this._isInTransaction = true;
      // Catching errors makes debugging more difficult, so we start with
      // errorThrown set to true before setting it to false after calling
      // close -- if it's still set to true in the finally block, it means
      // one of these calls threw.
      errorThrown = true;
      this.initializeAll(0);
      ret = method.call(scope, a, b, c, d, e, f);
      errorThrown = false;
    } finally {
      try {
        if (errorThrown) {
          // If `method` throws, prefer to show that stack trace over any thrown
          // by invoking `closeAll`.
          try {
            this.closeAll(0);
          } catch (err) {
          }
        } else {
          // Since `method` didn't throw, we don't want to silence the exception
          // here.
          this.closeAll(0);
        }
      } finally {
        this._isInTransaction = false;
      }
    }
    return ret;
  },

  initializeAll: function(startIndex) {
    var transactionWrappers = this.transactionWrappers;
    for (var i = startIndex; i < transactionWrappers.length; i++) {
      var wrapper = transactionWrappers[i];
      try {
        // Catching errors makes debugging more difficult, so we start with the
        // OBSERVED_ERROR state before overwriting it with the real return value
        // of initialize -- if it's still set to OBSERVED_ERROR in the finally
        // block, it means wrapper.initialize threw.
        this.wrapperInitData[i] = Transaction.OBSERVED_ERROR;
        this.wrapperInitData[i] = wrapper.initialize ?
          wrapper.initialize.call(this) :
          null;
      } finally {
        if (this.wrapperInitData[i] === Transaction.OBSERVED_ERROR) {
          // The initializer for wrapper i threw an error; initialize the
          // remaining wrappers but silence any exceptions from them to ensure
          // that the first error is the one to bubble up.
          try {
            this.initializeAll(i + 1);
          } catch (err) {
          }
        }
      }
    }
  },

  /**
   * Invokes each of `this.transactionWrappers.close[i]` functions, passing into
   * them the respective return values of `this.transactionWrappers.init[i]`
   * (`close`rs that correspond to initializers that failed will not be
   * invoked).
   */
  closeAll: function(startIndex) {
    ("production" !== process.env.NODE_ENV ? invariant(
      this.isInTransaction(),
      'Transaction.closeAll(): Cannot close transaction when none are open.'
    ) : invariant(this.isInTransaction()));
    var transactionWrappers = this.transactionWrappers;
    for (var i = startIndex; i < transactionWrappers.length; i++) {
      var wrapper = transactionWrappers[i];
      var initData = this.wrapperInitData[i];
      var errorThrown;
      try {
        // Catching errors makes debugging more difficult, so we start with
        // errorThrown set to true before setting it to false after calling
        // close -- if it's still set to true in the finally block, it means
        // wrapper.close threw.
        errorThrown = true;
        if (initData !== Transaction.OBSERVED_ERROR) {
          wrapper.close && wrapper.close.call(this, initData);
        }
        errorThrown = false;
      } finally {
        if (errorThrown) {
          // The closer for wrapper i threw an error; close the remaining
          // wrappers but silence any exceptions from them to ensure that the
          // first error is the one to bubble up.
          try {
            this.closeAll(i + 1);
          } catch (e) {
          }
        }
      }
    }
    this.wrapperInitData.length = 0;
  }
};

var Transaction = {

  Mixin: Mixin,

  /**
   * Token to look for to determine if an error occured.
   */
  OBSERVED_ERROR: {}

};

module.exports = Transaction;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],96:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ViewportMetrics
 */

"use strict";

var getUnboundedScrollPosition = require("./getUnboundedScrollPosition");

var ViewportMetrics = {

  currentScrollLeft: 0,

  currentScrollTop: 0,

  refreshScrollValues: function() {
    var scrollPosition = getUnboundedScrollPosition(window);
    ViewportMetrics.currentScrollLeft = scrollPosition.x;
    ViewportMetrics.currentScrollTop = scrollPosition.y;
  }

};

module.exports = ViewportMetrics;

},{"./getUnboundedScrollPosition":122}],97:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule accumulateInto
 */

"use strict";

var invariant = require("./invariant");

/**
 *
 * Accumulates items that must not be null or undefined into the first one. This
 * is used to conserve memory by avoiding array allocations, and thus sacrifices
 * API cleanness. Since `current` can be null before being passed in and not
 * null after this function, make sure to assign it back to `current`:
 *
 * `a = accumulateInto(a, b);`
 *
 * This API should be sparingly used. Try `accumulate` for something cleaner.
 *
 * @return {*|array<*>} An accumulation of items.
 */

function accumulateInto(current, next) {
  ("production" !== process.env.NODE_ENV ? invariant(
    next != null,
    'accumulateInto(...): Accumulated items must not be null or undefined.'
  ) : invariant(next != null));
  if (current == null) {
    return next;
  }

  // Both are not empty. Warning: Never call x.concat(y) when you are not
  // certain that x is an Array (x could be a string with concat method).
  var currentIsArray = Array.isArray(current);
  var nextIsArray = Array.isArray(next);

  if (currentIsArray && nextIsArray) {
    current.push.apply(current, next);
    return current;
  }

  if (currentIsArray) {
    current.push(next);
    return current;
  }

  if (nextIsArray) {
    // A bit too dangerous to mutate `next`.
    return [current].concat(next);
  }

  return [current, next];
}

module.exports = accumulateInto;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],98:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule adler32
 */

/* jslint bitwise:true */

"use strict";

var MOD = 65521;

// This is a clean-room implementation of adler32 designed for detecting
// if markup is not what we expect it to be. It does not need to be
// cryptographically strong, only reasonably good at detecting if markup
// generated on the server is different than that on the client.
function adler32(data) {
  var a = 1;
  var b = 0;
  for (var i = 0; i < data.length; i++) {
    a = (a + data.charCodeAt(i)) % MOD;
    b = (b + a) % MOD;
  }
  return a | (b << 16);
}

module.exports = adler32;

},{}],99:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule camelize
 * @typechecks
 */

var _hyphenPattern = /-(.)/g;

/**
 * Camelcases a hyphenated string, for example:
 *
 *   > camelize('background-color')
 *   < "backgroundColor"
 *
 * @param {string} string
 * @return {string}
 */
function camelize(string) {
  return string.replace(_hyphenPattern, function(_, character) {
    return character.toUpperCase();
  });
}

module.exports = camelize;

},{}],100:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule camelizeStyleName
 * @typechecks
 */

"use strict";

var camelize = require("./camelize");

var msPattern = /^-ms-/;

/**
 * Camelcases a hyphenated CSS property name, for example:
 *
 *   > camelizeStyleName('background-color')
 *   < "backgroundColor"
 *   > camelizeStyleName('-moz-transition')
 *   < "MozTransition"
 *   > camelizeStyleName('-ms-transition')
 *   < "msTransition"
 *
 * As Andi Smith suggests
 * (http://www.andismith.com/blog/2012/02/modernizr-prefixed/), an `-ms` prefix
 * is converted to lowercase `ms`.
 *
 * @param {string} string
 * @return {string}
 */
function camelizeStyleName(string) {
  return camelize(string.replace(msPattern, 'ms-'));
}

module.exports = camelizeStyleName;

},{"./camelize":99}],101:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule containsNode
 * @typechecks
 */

var isTextNode = require("./isTextNode");

/*jslint bitwise:true */

/**
 * Checks if a given DOM node contains or is another DOM node.
 *
 * @param {?DOMNode} outerNode Outer DOM node.
 * @param {?DOMNode} innerNode Inner DOM node.
 * @return {boolean} True if `outerNode` contains or is `innerNode`.
 */
function containsNode(outerNode, innerNode) {
  if (!outerNode || !innerNode) {
    return false;
  } else if (outerNode === innerNode) {
    return true;
  } else if (isTextNode(outerNode)) {
    return false;
  } else if (isTextNode(innerNode)) {
    return containsNode(outerNode, innerNode.parentNode);
  } else if (outerNode.contains) {
    return outerNode.contains(innerNode);
  } else if (outerNode.compareDocumentPosition) {
    return !!(outerNode.compareDocumentPosition(innerNode) & 16);
  } else {
    return false;
  }
}

module.exports = containsNode;

},{"./isTextNode":130}],102:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createArrayFrom
 * @typechecks
 */

var toArray = require("./toArray");

/**
 * Perform a heuristic test to determine if an object is "array-like".
 *
 *   A monk asked Joshu, a Zen master, "Has a dog Buddha nature?"
 *   Joshu replied: "Mu."
 *
 * This function determines if its argument has "array nature": it returns
 * true if the argument is an actual array, an `arguments' object, or an
 * HTMLCollection (e.g. node.childNodes or node.getElementsByTagName()).
 *
 * It will return false for other array-like objects like Filelist.
 *
 * @param {*} obj
 * @return {boolean}
 */
function hasArrayNature(obj) {
  return (
    // not null/false
    !!obj &&
    // arrays are objects, NodeLists are functions in Safari
    (typeof obj == 'object' || typeof obj == 'function') &&
    // quacks like an array
    ('length' in obj) &&
    // not window
    !('setInterval' in obj) &&
    // no DOM node should be considered an array-like
    // a 'select' element has 'length' and 'item' properties on IE8
    (typeof obj.nodeType != 'number') &&
    (
      // a real array
      (// HTMLCollection/NodeList
      (Array.isArray(obj) ||
      // arguments
      ('callee' in obj) || 'item' in obj))
    )
  );
}

/**
 * Ensure that the argument is an array by wrapping it in an array if it is not.
 * Creates a copy of the argument if it is already an array.
 *
 * This is mostly useful idiomatically:
 *
 *   var createArrayFrom = require('createArrayFrom');
 *
 *   function takesOneOrMoreThings(things) {
 *     things = createArrayFrom(things);
 *     ...
 *   }
 *
 * This allows you to treat `things' as an array, but accept scalars in the API.
 *
 * If you need to convert an array-like object, like `arguments`, into an array
 * use toArray instead.
 *
 * @param {*} obj
 * @return {array}
 */
function createArrayFrom(obj) {
  if (!hasArrayNature(obj)) {
    return [obj];
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else {
    return toArray(obj);
  }
}

module.exports = createArrayFrom;

},{"./toArray":143}],103:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createFullPageComponent
 * @typechecks
 */

"use strict";

// Defeat circular references by requiring this directly.
var ReactCompositeComponent = require("./ReactCompositeComponent");
var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

/**
 * Create a component that will throw an exception when unmounted.
 *
 * Components like <html> <head> and <body> can't be removed or added
 * easily in a cross-browser way, however it's valuable to be able to
 * take advantage of React's reconciliation for styling and <title>
 * management. So we just document it and throw in dangerous cases.
 *
 * @param {string} tag The tag to wrap
 * @return {function} convenience constructor of new component
 */
function createFullPageComponent(tag) {
  var elementFactory = ReactElement.createFactory(tag);

  var FullPageComponent = ReactCompositeComponent.createClass({
    displayName: 'ReactFullPageComponent' + tag,

    componentWillUnmount: function() {
      ("production" !== process.env.NODE_ENV ? invariant(
        false,
        '%s tried to unmount. Because of cross-browser quirks it is ' +
        'impossible to unmount some top-level components (eg <html>, <head>, ' +
        'and <body>) reliably and efficiently. To fix this, have a single ' +
        'top-level component that never unmounts render these elements.',
        this.constructor.displayName
      ) : invariant(false));
    },

    render: function() {
      return elementFactory(this.props);
    }
  });

  return FullPageComponent;
}

module.exports = createFullPageComponent;

}).call(this,require("ngpmcQ"))
},{"./ReactCompositeComponent":34,"./ReactElement":52,"./invariant":126,"ngpmcQ":176}],104:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createNodesFromMarkup
 * @typechecks
 */

/*jslint evil: true, sub: true */

var ExecutionEnvironment = require("./ExecutionEnvironment");

var createArrayFrom = require("./createArrayFrom");
var getMarkupWrap = require("./getMarkupWrap");
var invariant = require("./invariant");

/**
 * Dummy container used to render all markup.
 */
var dummyNode =
  ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;

/**
 * Pattern used by `getNodeName`.
 */
var nodeNamePattern = /^\s*<(\w+)/;

/**
 * Extracts the `nodeName` of the first element in a string of markup.
 *
 * @param {string} markup String of markup.
 * @return {?string} Node name of the supplied markup.
 */
function getNodeName(markup) {
  var nodeNameMatch = markup.match(nodeNamePattern);
  return nodeNameMatch && nodeNameMatch[1].toLowerCase();
}

/**
 * Creates an array containing the nodes rendered from the supplied markup. The
 * optionally supplied `handleScript` function will be invoked once for each
 * <script> element that is rendered. If no `handleScript` function is supplied,
 * an exception is thrown if any <script> elements are rendered.
 *
 * @param {string} markup A string of valid HTML markup.
 * @param {?function} handleScript Invoked once for each rendered <script>.
 * @return {array<DOMElement|DOMTextNode>} An array of rendered nodes.
 */
function createNodesFromMarkup(markup, handleScript) {
  var node = dummyNode;
  ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'createNodesFromMarkup dummy not initialized') : invariant(!!dummyNode));
  var nodeName = getNodeName(markup);

  var wrap = nodeName && getMarkupWrap(nodeName);
  if (wrap) {
    node.innerHTML = wrap[1] + markup + wrap[2];

    var wrapDepth = wrap[0];
    while (wrapDepth--) {
      node = node.lastChild;
    }
  } else {
    node.innerHTML = markup;
  }

  var scripts = node.getElementsByTagName('script');
  if (scripts.length) {
    ("production" !== process.env.NODE_ENV ? invariant(
      handleScript,
      'createNodesFromMarkup(...): Unexpected <script> element rendered.'
    ) : invariant(handleScript));
    createArrayFrom(scripts).forEach(handleScript);
  }

  var nodes = createArrayFrom(node.childNodes);
  while (node.lastChild) {
    node.removeChild(node.lastChild);
  }
  return nodes;
}

module.exports = createNodesFromMarkup;

}).call(this,require("ngpmcQ"))
},{"./ExecutionEnvironment":21,"./createArrayFrom":102,"./getMarkupWrap":118,"./invariant":126,"ngpmcQ":176}],105:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule dangerousStyleValue
 * @typechecks static-only
 */

"use strict";

var CSSProperty = require("./CSSProperty");

var isUnitlessNumber = CSSProperty.isUnitlessNumber;

/**
 * Convert a value into the proper css writable value. The style name `name`
 * should be logical (no hyphens), as specified
 * in `CSSProperty.isUnitlessNumber`.
 *
 * @param {string} name CSS property name such as `topMargin`.
 * @param {*} value CSS property value such as `10px`.
 * @return {string} Normalized style value with dimensions applied.
 */
function dangerousStyleValue(name, value) {
  // Note that we've removed escapeTextForBrowser() calls here since the
  // whole string will be escaped when the attribute is injected into
  // the markup. If you provide unsafe user data here they can inject
  // arbitrary CSS which may be problematic (I couldn't repro this):
  // https://www.owasp.org/index.php/XSS_Filter_Evasion_Cheat_Sheet
  // http://www.thespanner.co.uk/2007/11/26/ultimate-xss-css-injection/
  // This is not an XSS hole but instead a potential CSS injection issue
  // which has lead to a greater discussion about how we're going to
  // trust URLs moving forward. See #2115901

  var isEmpty = value == null || typeof value === 'boolean' || value === '';
  if (isEmpty) {
    return '';
  }

  var isNonNumeric = isNaN(value);
  if (isNonNumeric || value === 0 ||
      isUnitlessNumber.hasOwnProperty(name) && isUnitlessNumber[name]) {
    return '' + value; // cast to string
  }

  if (typeof value === 'string') {
    value = value.trim();
  }
  return value + 'px';
}

module.exports = dangerousStyleValue;

},{"./CSSProperty":3}],106:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule deprecated
 */

var assign = require("./Object.assign");
var warning = require("./warning");

/**
 * This will log a single deprecation notice per function and forward the call
 * on to the new API.
 *
 * @param {string} namespace The namespace of the call, eg 'React'
 * @param {string} oldName The old function name, eg 'renderComponent'
 * @param {string} newName The new function name, eg 'render'
 * @param {*} ctx The context this forwarded call should run in
 * @param {function} fn The function to forward on to
 * @return {*} Will be the value as returned from `fn`
 */
function deprecated(namespace, oldName, newName, ctx, fn) {
  var warned = false;
  if ("production" !== process.env.NODE_ENV) {
    var newFn = function() {
      ("production" !== process.env.NODE_ENV ? warning(
        warned,
        (namespace + "." + oldName + " will be deprecated in a future version. ") +
        ("Use " + namespace + "." + newName + " instead.")
      ) : null);
      warned = true;
      return fn.apply(ctx, arguments);
    };
    newFn.displayName = (namespace + "_" + oldName);
    // We need to make sure all properties of the original fn are copied over.
    // In particular, this is needed to support PropTypes
    return assign(newFn, fn);
  }

  return fn;
}

module.exports = deprecated;

}).call(this,require("ngpmcQ"))
},{"./Object.assign":26,"./warning":145,"ngpmcQ":176}],107:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule emptyFunction
 */

function makeEmptyFunction(arg) {
  return function() {
    return arg;
  };
}

/**
 * This function accepts and discards inputs; it has no side effects. This is
 * primarily useful idiomatically for overridable function endpoints which
 * always need to be callable, since JS lacks a null-call idiom ala Cocoa.
 */
function emptyFunction() {}

emptyFunction.thatReturns = makeEmptyFunction;
emptyFunction.thatReturnsFalse = makeEmptyFunction(false);
emptyFunction.thatReturnsTrue = makeEmptyFunction(true);
emptyFunction.thatReturnsNull = makeEmptyFunction(null);
emptyFunction.thatReturnsThis = function() { return this; };
emptyFunction.thatReturnsArgument = function(arg) { return arg; };

module.exports = emptyFunction;

},{}],108:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule emptyObject
 */

"use strict";

var emptyObject = {};

if ("production" !== process.env.NODE_ENV) {
  Object.freeze(emptyObject);
}

module.exports = emptyObject;

}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],109:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule escapeTextForBrowser
 * @typechecks static-only
 */

"use strict";

var ESCAPE_LOOKUP = {
  "&": "&amp;",
  ">": "&gt;",
  "<": "&lt;",
  "\"": "&quot;",
  "'": "&#x27;"
};

var ESCAPE_REGEX = /[&><"']/g;

function escaper(match) {
  return ESCAPE_LOOKUP[match];
}

/**
 * Escapes text to prevent scripting attacks.
 *
 * @param {*} text Text value to escape.
 * @return {string} An escaped string.
 */
function escapeTextForBrowser(text) {
  return ('' + text).replace(ESCAPE_REGEX, escaper);
}

module.exports = escapeTextForBrowser;

},{}],110:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule flattenChildren
 */

"use strict";

var ReactTextComponent = require("./ReactTextComponent");

var traverseAllChildren = require("./traverseAllChildren");
var warning = require("./warning");

/**
 * @param {function} traverseContext Context passed through traversal.
 * @param {?ReactComponent} child React child component.
 * @param {!string} name String name of key path to child.
 */
function flattenSingleChildIntoContext(traverseContext, child, name) {
  // We found a component instance.
  var result = traverseContext;
  var keyUnique = !result.hasOwnProperty(name);
  ("production" !== process.env.NODE_ENV ? warning(
    keyUnique,
    'flattenChildren(...): Encountered two children with the same key, ' +
    '`%s`. Child keys must be unique; when two children share a key, only ' +
    'the first child will be used.',
    name
  ) : null);
  if (keyUnique && child != null) {
    var type = typeof child;
    var normalizedValue;

    if (type === 'string') {
      normalizedValue = ReactTextComponent(child);
    } else if (type === 'number') {
      normalizedValue = ReactTextComponent('' + child);
    } else {
      normalizedValue = child;
    }

    result[name] = normalizedValue;
  }
}

/**
 * Flattens children that are typically specified as `props.children`. Any null
 * children will not be included in the resulting object.
 * @return {!object} flattened children keyed by name.
 */
function flattenChildren(children) {
  if (children == null) {
    return children;
  }
  var result = {};
  traverseAllChildren(children, flattenSingleChildIntoContext, result);
  return result;
}

module.exports = flattenChildren;

}).call(this,require("ngpmcQ"))
},{"./ReactTextComponent":78,"./traverseAllChildren":144,"./warning":145,"ngpmcQ":176}],111:[function(require,module,exports){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule focusNode
 */

"use strict";

/**
 * @param {DOMElement} node input/textarea to focus
 */
function focusNode(node) {
  // IE8 can throw "Can't move focus to the control because it is invisible,
  // not enabled, or of a type that does not accept the focus." for all kinds of
  // reasons that are too expensive and fragile to test.
  try {
    node.focus();
  } catch(e) {
  }
}

module.exports = focusNode;

},{}],112:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule forEachAccumulated
 */

"use strict";

/**
 * @param {array} an "accumulation" of items which is either an Array or
 * a single item. Useful when paired with the `accumulate` module. This is a
 * simple utility that allows us to reason about a collection of items, but
 * handling the case when there is exactly one item (and we do not need to
 * allocate an array).
 */
var forEachAccumulated = function(arr, cb, scope) {
  if (Array.isArray(arr)) {
    arr.forEach(cb, scope);
  } else if (arr) {
    cb.call(scope, arr);
  }
};

module.exports = forEachAccumulated;

},{}],113:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getActiveElement
 * @typechecks
 */

/**
 * Same as document.activeElement but wraps in a try-catch block. In IE it is
 * not safe to call document.activeElement if there is nothing focused.
 *
 * The activeElement will be null only if the document body is not yet defined.
 */
function getActiveElement() /*?DOMElement*/ {
  try {
    return document.activeElement || document.body;
  } catch (e) {
    return document.body;
  }
}

module.exports = getActiveElement;

},{}],114:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventCharCode
 * @typechecks static-only
 */

"use strict";

/**
 * `charCode` represents the actual "character code" and is safe to use with
 * `String.fromCharCode`. As such, only keys that correspond to printable
 * characters produce a valid `charCode`, the only exception to this is Enter.
 * The Tab-key is considered non-printable and does not have a `charCode`,
 * presumably because it does not produce a tab-character in browsers.
 *
 * @param {object} nativeEvent Native browser event.
 * @return {string} Normalized `charCode` property.
 */
function getEventCharCode(nativeEvent) {
  var charCode;
  var keyCode = nativeEvent.keyCode;

  if ('charCode' in nativeEvent) {
    charCode = nativeEvent.charCode;

    // FF does not set `charCode` for the Enter-key, check against `keyCode`.
    if (charCode === 0 && keyCode === 13) {
      charCode = 13;
    }
  } else {
    // IE8 does not implement `charCode`, but `keyCode` has the correct value.
    charCode = keyCode;
  }

  // Some non-printable keys are reported in `charCode`/`keyCode`, discard them.
  // Must not discard the (non-)printable Enter-key.
  if (charCode >= 32 || charCode === 13) {
    return charCode;
  }

  return 0;
}

module.exports = getEventCharCode;

},{}],115:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventKey
 * @typechecks static-only
 */

"use strict";

var getEventCharCode = require("./getEventCharCode");

/**
 * Normalization of deprecated HTML5 `key` values
 * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
 */
var normalizeKey = {
  'Esc': 'Escape',
  'Spacebar': ' ',
  'Left': 'ArrowLeft',
  'Up': 'ArrowUp',
  'Right': 'ArrowRight',
  'Down': 'ArrowDown',
  'Del': 'Delete',
  'Win': 'OS',
  'Menu': 'ContextMenu',
  'Apps': 'ContextMenu',
  'Scroll': 'ScrollLock',
  'MozPrintableKey': 'Unidentified'
};

/**
 * Translation from legacy `keyCode` to HTML5 `key`
 * Only special keys supported, all others depend on keyboard layout or browser
 * @see https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent#Key_names
 */
var translateToKey = {
  8: 'Backspace',
  9: 'Tab',
  12: 'Clear',
  13: 'Enter',
  16: 'Shift',
  17: 'Control',
  18: 'Alt',
  19: 'Pause',
  20: 'CapsLock',
  27: 'Escape',
  32: ' ',
  33: 'PageUp',
  34: 'PageDown',
  35: 'End',
  36: 'Home',
  37: 'ArrowLeft',
  38: 'ArrowUp',
  39: 'ArrowRight',
  40: 'ArrowDown',
  45: 'Insert',
  46: 'Delete',
  112: 'F1', 113: 'F2', 114: 'F3', 115: 'F4', 116: 'F5', 117: 'F6',
  118: 'F7', 119: 'F8', 120: 'F9', 121: 'F10', 122: 'F11', 123: 'F12',
  144: 'NumLock',
  145: 'ScrollLock',
  224: 'Meta'
};

/**
 * @param {object} nativeEvent Native browser event.
 * @return {string} Normalized `key` property.
 */
function getEventKey(nativeEvent) {
  if (nativeEvent.key) {
    // Normalize inconsistent values reported by browsers due to
    // implementations of a working draft specification.

    // FireFox implements `key` but returns `MozPrintableKey` for all
    // printable characters (normalized to `Unidentified`), ignore it.
    var key = normalizeKey[nativeEvent.key] || nativeEvent.key;
    if (key !== 'Unidentified') {
      return key;
    }
  }

  // Browser does not implement `key`, polyfill as much of it as we can.
  if (nativeEvent.type === 'keypress') {
    var charCode = getEventCharCode(nativeEvent);

    // The enter-key is technically both printable and non-printable and can
    // thus be captured by `keypress`, no other non-printable key should.
    return charCode === 13 ? 'Enter' : String.fromCharCode(charCode);
  }
  if (nativeEvent.type === 'keydown' || nativeEvent.type === 'keyup') {
    // While user keyboard layout determines the actual meaning of each
    // `keyCode` value, almost all function keys have a universal value.
    return translateToKey[nativeEvent.keyCode] || 'Unidentified';
  }
  return '';
}

module.exports = getEventKey;

},{"./getEventCharCode":114}],116:[function(require,module,exports){
/**
 * Copyright 2013 Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventModifierState
 * @typechecks static-only
 */

"use strict";

/**
 * Translation from modifier key to the associated property in the event.
 * @see http://www.w3.org/TR/DOM-Level-3-Events/#keys-Modifiers
 */

var modifierKeyToProp = {
  'Alt': 'altKey',
  'Control': 'ctrlKey',
  'Meta': 'metaKey',
  'Shift': 'shiftKey'
};

// IE8 does not implement getModifierState so we simply map it to the only
// modifier keys exposed by the event itself, does not support Lock-keys.
// Currently, all major browsers except Chrome seems to support Lock-keys.
function modifierStateGetter(keyArg) {
  /*jshint validthis:true */
  var syntheticEvent = this;
  var nativeEvent = syntheticEvent.nativeEvent;
  if (nativeEvent.getModifierState) {
    return nativeEvent.getModifierState(keyArg);
  }
  var keyProp = modifierKeyToProp[keyArg];
  return keyProp ? !!nativeEvent[keyProp] : false;
}

function getEventModifierState(nativeEvent) {
  return modifierStateGetter;
}

module.exports = getEventModifierState;

},{}],117:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getEventTarget
 * @typechecks static-only
 */

"use strict";

/**
 * Gets the target node from a native browser event by accounting for
 * inconsistencies in browser DOM APIs.
 *
 * @param {object} nativeEvent Native browser event.
 * @return {DOMEventTarget} Target node.
 */
function getEventTarget(nativeEvent) {
  var target = nativeEvent.target || nativeEvent.srcElement || window;
  // Safari may fire events on text nodes (Node.TEXT_NODE is 3).
  // @see http://www.quirksmode.org/js/events_properties.html
  return target.nodeType === 3 ? target.parentNode : target;
}

module.exports = getEventTarget;

},{}],118:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getMarkupWrap
 */

var ExecutionEnvironment = require("./ExecutionEnvironment");

var invariant = require("./invariant");

/**
 * Dummy container used to detect which wraps are necessary.
 */
var dummyNode =
  ExecutionEnvironment.canUseDOM ? document.createElement('div') : null;

/**
 * Some browsers cannot use `innerHTML` to render certain elements standalone,
 * so we wrap them, render the wrapped nodes, then extract the desired node.
 *
 * In IE8, certain elements cannot render alone, so wrap all elements ('*').
 */
var shouldWrap = {
  // Force wrapping for SVG elements because if they get created inside a <div>,
  // they will be initialized in the wrong namespace (and will not display).
  'circle': true,
  'defs': true,
  'ellipse': true,
  'g': true,
  'line': true,
  'linearGradient': true,
  'path': true,
  'polygon': true,
  'polyline': true,
  'radialGradient': true,
  'rect': true,
  'stop': true,
  'text': true
};

var selectWrap = [1, '<select multiple="true">', '</select>'];
var tableWrap = [1, '<table>', '</table>'];
var trWrap = [3, '<table><tbody><tr>', '</tr></tbody></table>'];

var svgWrap = [1, '<svg>', '</svg>'];

var markupWrap = {
  '*': [1, '?<div>', '</div>'],

  'area': [1, '<map>', '</map>'],
  'col': [2, '<table><tbody></tbody><colgroup>', '</colgroup></table>'],
  'legend': [1, '<fieldset>', '</fieldset>'],
  'param': [1, '<object>', '</object>'],
  'tr': [2, '<table><tbody>', '</tbody></table>'],

  'optgroup': selectWrap,
  'option': selectWrap,

  'caption': tableWrap,
  'colgroup': tableWrap,
  'tbody': tableWrap,
  'tfoot': tableWrap,
  'thead': tableWrap,

  'td': trWrap,
  'th': trWrap,

  'circle': svgWrap,
  'defs': svgWrap,
  'ellipse': svgWrap,
  'g': svgWrap,
  'line': svgWrap,
  'linearGradient': svgWrap,
  'path': svgWrap,
  'polygon': svgWrap,
  'polyline': svgWrap,
  'radialGradient': svgWrap,
  'rect': svgWrap,
  'stop': svgWrap,
  'text': svgWrap
};

/**
 * Gets the markup wrap configuration for the supplied `nodeName`.
 *
 * NOTE: This lazily detects which wraps are necessary for the current browser.
 *
 * @param {string} nodeName Lowercase `nodeName`.
 * @return {?array} Markup wrap configuration, if applicable.
 */
function getMarkupWrap(nodeName) {
  ("production" !== process.env.NODE_ENV ? invariant(!!dummyNode, 'Markup wrapping node not initialized') : invariant(!!dummyNode));
  if (!markupWrap.hasOwnProperty(nodeName)) {
    nodeName = '*';
  }
  if (!shouldWrap.hasOwnProperty(nodeName)) {
    if (nodeName === '*') {
      dummyNode.innerHTML = '<link />';
    } else {
      dummyNode.innerHTML = '<' + nodeName + '></' + nodeName + '>';
    }
    shouldWrap[nodeName] = !dummyNode.firstChild;
  }
  return shouldWrap[nodeName] ? markupWrap[nodeName] : null;
}


module.exports = getMarkupWrap;

}).call(this,require("ngpmcQ"))
},{"./ExecutionEnvironment":21,"./invariant":126,"ngpmcQ":176}],119:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getNodeForCharacterOffset
 */

"use strict";

/**
 * Given any node return the first leaf node without children.
 *
 * @param {DOMElement|DOMTextNode} node
 * @return {DOMElement|DOMTextNode}
 */
function getLeafNode(node) {
  while (node && node.firstChild) {
    node = node.firstChild;
  }
  return node;
}

/**
 * Get the next sibling within a container. This will walk up the
 * DOM if a node's siblings have been exhausted.
 *
 * @param {DOMElement|DOMTextNode} node
 * @return {?DOMElement|DOMTextNode}
 */
function getSiblingNode(node) {
  while (node) {
    if (node.nextSibling) {
      return node.nextSibling;
    }
    node = node.parentNode;
  }
}

/**
 * Get object describing the nodes which contain characters at offset.
 *
 * @param {DOMElement|DOMTextNode} root
 * @param {number} offset
 * @return {?object}
 */
function getNodeForCharacterOffset(root, offset) {
  var node = getLeafNode(root);
  var nodeStart = 0;
  var nodeEnd = 0;

  while (node) {
    if (node.nodeType == 3) {
      nodeEnd = nodeStart + node.textContent.length;

      if (nodeStart <= offset && nodeEnd >= offset) {
        return {
          node: node,
          offset: offset - nodeStart
        };
      }

      nodeStart = nodeEnd;
    }

    node = getLeafNode(getSiblingNode(node));
  }
}

module.exports = getNodeForCharacterOffset;

},{}],120:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getReactRootElementInContainer
 */

"use strict";

var DOC_NODE_TYPE = 9;

/**
 * @param {DOMElement|DOMDocument} container DOM element that may contain
 *                                           a React component
 * @return {?*} DOM element that may have the reactRoot ID, or null.
 */
function getReactRootElementInContainer(container) {
  if (!container) {
    return null;
  }

  if (container.nodeType === DOC_NODE_TYPE) {
    return container.documentElement;
  } else {
    return container.firstChild;
  }
}

module.exports = getReactRootElementInContainer;

},{}],121:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getTextContentAccessor
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var contentKey = null;

/**
 * Gets the key used to access text content on a DOM node.
 *
 * @return {?string} Key used to access text content.
 * @internal
 */
function getTextContentAccessor() {
  if (!contentKey && ExecutionEnvironment.canUseDOM) {
    // Prefer textContent to innerText because many browsers support both but
    // SVG <text> elements don't support innerText even when <div> does.
    contentKey = 'textContent' in document.documentElement ?
      'textContent' :
      'innerText';
  }
  return contentKey;
}

module.exports = getTextContentAccessor;

},{"./ExecutionEnvironment":21}],122:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule getUnboundedScrollPosition
 * @typechecks
 */

"use strict";

/**
 * Gets the scroll position of the supplied element or window.
 *
 * The return values are unbounded, unlike `getScrollPosition`. This means they
 * may be negative or exceed the element boundaries (which is possible using
 * inertial scrolling).
 *
 * @param {DOMWindow|DOMElement} scrollable
 * @return {object} Map with `x` and `y` keys.
 */
function getUnboundedScrollPosition(scrollable) {
  if (scrollable === window) {
    return {
      x: window.pageXOffset || document.documentElement.scrollLeft,
      y: window.pageYOffset || document.documentElement.scrollTop
    };
  }
  return {
    x: scrollable.scrollLeft,
    y: scrollable.scrollTop
  };
}

module.exports = getUnboundedScrollPosition;

},{}],123:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule hyphenate
 * @typechecks
 */

var _uppercasePattern = /([A-Z])/g;

/**
 * Hyphenates a camelcased string, for example:
 *
 *   > hyphenate('backgroundColor')
 *   < "background-color"
 *
 * For CSS style names, use `hyphenateStyleName` instead which works properly
 * with all vendor prefixes, including `ms`.
 *
 * @param {string} string
 * @return {string}
 */
function hyphenate(string) {
  return string.replace(_uppercasePattern, '-$1').toLowerCase();
}

module.exports = hyphenate;

},{}],124:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule hyphenateStyleName
 * @typechecks
 */

"use strict";

var hyphenate = require("./hyphenate");

var msPattern = /^ms-/;

/**
 * Hyphenates a camelcased CSS property name, for example:
 *
 *   > hyphenateStyleName('backgroundColor')
 *   < "background-color"
 *   > hyphenateStyleName('MozTransition')
 *   < "-moz-transition"
 *   > hyphenateStyleName('msTransition')
 *   < "-ms-transition"
 *
 * As Modernizr suggests (http://modernizr.com/docs/#prefixed), an `ms` prefix
 * is converted to `-ms-`.
 *
 * @param {string} string
 * @return {string}
 */
function hyphenateStyleName(string) {
  return hyphenate(string).replace(msPattern, '-ms-');
}

module.exports = hyphenateStyleName;

},{"./hyphenate":123}],125:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule instantiateReactComponent
 * @typechecks static-only
 */

"use strict";

var warning = require("./warning");

var ReactElement = require("./ReactElement");
var ReactLegacyElement = require("./ReactLegacyElement");
var ReactNativeComponent = require("./ReactNativeComponent");
var ReactEmptyComponent = require("./ReactEmptyComponent");

/**
 * Given an `element` create an instance that will actually be mounted.
 *
 * @param {object} element
 * @param {*} parentCompositeType The composite type that resolved this.
 * @return {object} A new instance of the element's constructor.
 * @protected
 */
function instantiateReactComponent(element, parentCompositeType) {
  var instance;

  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      element && (typeof element.type === 'function' ||
                     typeof element.type === 'string'),
      'Only functions or strings can be mounted as React components.'
    ) : null);

    // Resolve mock instances
    if (element.type._mockedReactClassConstructor) {
      // If this is a mocked class, we treat the legacy factory as if it was the
      // class constructor for future proofing unit tests. Because this might
      // be mocked as a legacy factory, we ignore any warnings triggerd by
      // this temporary hack.
      ReactLegacyElement._isLegacyCallWarningEnabled = false;
      try {
        instance = new element.type._mockedReactClassConstructor(
          element.props
        );
      } finally {
        ReactLegacyElement._isLegacyCallWarningEnabled = true;
      }

      // If the mock implementation was a legacy factory, then it returns a
      // element. We need to turn this into a real component instance.
      if (ReactElement.isValidElement(instance)) {
        instance = new instance.type(instance.props);
      }

      var render = instance.render;
      if (!render) {
        // For auto-mocked factories, the prototype isn't shimmed and therefore
        // there is no render function on the instance. We replace the whole
        // component with an empty component instance instead.
        element = ReactEmptyComponent.getEmptyComponent();
      } else {
        if (render._isMockFunction && !render._getMockImplementation()) {
          // Auto-mocked components may have a prototype with a mocked render
          // function. For those, we'll need to mock the result of the render
          // since we consider undefined to be invalid results from render.
          render.mockImplementation(
            ReactEmptyComponent.getEmptyComponent
          );
        }
        instance.construct(element);
        return instance;
      }
    }
  }

  // Special case string values
  if (typeof element.type === 'string') {
    instance = ReactNativeComponent.createInstanceForTag(
      element.type,
      element.props,
      parentCompositeType
    );
  } else {
    // Normal case for non-mocks and non-strings
    instance = new element.type(element.props);
  }

  if ("production" !== process.env.NODE_ENV) {
    ("production" !== process.env.NODE_ENV ? warning(
      typeof instance.construct === 'function' &&
      typeof instance.mountComponent === 'function' &&
      typeof instance.receiveComponent === 'function',
      'Only React Components can be mounted.'
    ) : null);
  }

  // This actually sets up the internal instance. This will become decoupled
  // from the public instance in a future diff.
  instance.construct(element);

  return instance;
}

module.exports = instantiateReactComponent;

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./ReactEmptyComponent":54,"./ReactLegacyElement":61,"./ReactNativeComponent":66,"./warning":145,"ngpmcQ":176}],126:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule invariant
 */

"use strict";

/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function(condition, format, a, b, c, d, e, f) {
  if ("production" !== process.env.NODE_ENV) {
    if (format === undefined) {
      throw new Error('invariant requires an error message argument');
    }
  }

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error(
        'Minified exception occurred; use the non-minified dev environment ' +
        'for the full error message and additional helpful warnings.'
      );
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error(
        'Invariant Violation: ' +
        format.replace(/%s/g, function() { return args[argIndex++]; })
      );
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;

}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],127:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isEventSupported
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var useHasFeature;
if (ExecutionEnvironment.canUseDOM) {
  useHasFeature =
    document.implementation &&
    document.implementation.hasFeature &&
    // always returns true in newer browsers as per the standard.
    // @see http://dom.spec.whatwg.org/#dom-domimplementation-hasfeature
    document.implementation.hasFeature('', '') !== true;
}

/**
 * Checks if an event is supported in the current execution environment.
 *
 * NOTE: This will not work correctly for non-generic events such as `change`,
 * `reset`, `load`, `error`, and `select`.
 *
 * Borrows from Modernizr.
 *
 * @param {string} eventNameSuffix Event name, e.g. "click".
 * @param {?boolean} capture Check if the capture phase is supported.
 * @return {boolean} True if the event is supported.
 * @internal
 * @license Modernizr 3.0.0pre (Custom Build) | MIT
 */
function isEventSupported(eventNameSuffix, capture) {
  if (!ExecutionEnvironment.canUseDOM ||
      capture && !('addEventListener' in document)) {
    return false;
  }

  var eventName = 'on' + eventNameSuffix;
  var isSupported = eventName in document;

  if (!isSupported) {
    var element = document.createElement('div');
    element.setAttribute(eventName, 'return;');
    isSupported = typeof element[eventName] === 'function';
  }

  if (!isSupported && useHasFeature && eventNameSuffix === 'wheel') {
    // This is the only way to test support for the `wheel` event in IE9+.
    isSupported = document.implementation.hasFeature('Events.wheel', '3.0');
  }

  return isSupported;
}

module.exports = isEventSupported;

},{"./ExecutionEnvironment":21}],128:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isNode
 * @typechecks
 */

/**
 * @param {*} object The object to check.
 * @return {boolean} Whether or not the object is a DOM node.
 */
function isNode(object) {
  return !!(object && (
    typeof Node === 'function' ? object instanceof Node :
      typeof object === 'object' &&
      typeof object.nodeType === 'number' &&
      typeof object.nodeName === 'string'
  ));
}

module.exports = isNode;

},{}],129:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isTextInputElement
 */

"use strict";

/**
 * @see http://www.whatwg.org/specs/web-apps/current-work/multipage/the-input-element.html#input-type-attr-summary
 */
var supportedInputTypes = {
  'color': true,
  'date': true,
  'datetime': true,
  'datetime-local': true,
  'email': true,
  'month': true,
  'number': true,
  'password': true,
  'range': true,
  'search': true,
  'tel': true,
  'text': true,
  'time': true,
  'url': true,
  'week': true
};

function isTextInputElement(elem) {
  return elem && (
    (elem.nodeName === 'INPUT' && supportedInputTypes[elem.type]) ||
    elem.nodeName === 'TEXTAREA'
  );
}

module.exports = isTextInputElement;

},{}],130:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule isTextNode
 * @typechecks
 */

var isNode = require("./isNode");

/**
 * @param {*} object The object to check.
 * @return {boolean} Whether or not the object is a DOM text node.
 */
function isTextNode(object) {
  return isNode(object) && object.nodeType == 3;
}

module.exports = isTextNode;

},{"./isNode":128}],131:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule joinClasses
 * @typechecks static-only
 */

"use strict";

/**
 * Combines multiple className strings into one.
 * http://jsperf.com/joinclasses-args-vs-array
 *
 * @param {...?string} classes
 * @return {string}
 */
function joinClasses(className/*, ... */) {
  if (!className) {
    className = '';
  }
  var nextClass;
  var argLength = arguments.length;
  if (argLength > 1) {
    for (var ii = 1; ii < argLength; ii++) {
      nextClass = arguments[ii];
      if (nextClass) {
        className = (className ? className + ' ' : '') + nextClass;
      }
    }
  }
  return className;
}

module.exports = joinClasses;

},{}],132:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule keyMirror
 * @typechecks static-only
 */

"use strict";

var invariant = require("./invariant");

/**
 * Constructs an enumeration with keys equal to their value.
 *
 * For example:
 *
 *   var COLORS = keyMirror({blue: null, red: null});
 *   var myColor = COLORS.blue;
 *   var isColorValid = !!COLORS[myColor];
 *
 * The last line could not be performed if the values of the generated enum were
 * not equal to their keys.
 *
 *   Input:  {key1: val1, key2: val2}
 *   Output: {key1: key1, key2: key2}
 *
 * @param {object} obj
 * @return {object}
 */
var keyMirror = function(obj) {
  var ret = {};
  var key;
  ("production" !== process.env.NODE_ENV ? invariant(
    obj instanceof Object && !Array.isArray(obj),
    'keyMirror(...): Argument must be an object.'
  ) : invariant(obj instanceof Object && !Array.isArray(obj)));
  for (key in obj) {
    if (!obj.hasOwnProperty(key)) {
      continue;
    }
    ret[key] = key;
  }
  return ret;
};

module.exports = keyMirror;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],133:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule keyOf
 */

/**
 * Allows extraction of a minified key. Let's the build system minify keys
 * without loosing the ability to dynamically use key strings as values
 * themselves. Pass in an object with a single key/val pair and it will return
 * you the string key of that single record. Suppose you want to grab the
 * value for a key 'className' inside of an object. Key/val minification may
 * have aliased that key to be 'xa12'. keyOf({className: null}) will return
 * 'xa12' in that case. Resolve keys you want to use once at startup time, then
 * reuse those resolutions.
 */
var keyOf = function(oneKeyObj) {
  var key;
  for (key in oneKeyObj) {
    if (!oneKeyObj.hasOwnProperty(key)) {
      continue;
    }
    return key;
  }
  return null;
};


module.exports = keyOf;

},{}],134:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule mapObject
 */

'use strict';

var hasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Executes the provided `callback` once for each enumerable own property in the
 * object and constructs a new object from the results. The `callback` is
 * invoked with three arguments:
 *
 *  - the property value
 *  - the property name
 *  - the object being traversed
 *
 * Properties that are added after the call to `mapObject` will not be visited
 * by `callback`. If the values of existing properties are changed, the value
 * passed to `callback` will be the value at the time `mapObject` visits them.
 * Properties that are deleted before being visited are not visited.
 *
 * @grep function objectMap()
 * @grep function objMap()
 *
 * @param {?object} object
 * @param {function} callback
 * @param {*} context
 * @return {?object}
 */
function mapObject(object, callback, context) {
  if (!object) {
    return null;
  }
  var result = {};
  for (var name in object) {
    if (hasOwnProperty.call(object, name)) {
      result[name] = callback.call(context, object[name], name, object);
    }
  }
  return result;
}

module.exports = mapObject;

},{}],135:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule memoizeStringOnly
 * @typechecks static-only
 */

"use strict";

/**
 * Memoizes the return value of a function that accepts one string argument.
 *
 * @param {function} callback
 * @return {function}
 */
function memoizeStringOnly(callback) {
  var cache = {};
  return function(string) {
    if (cache.hasOwnProperty(string)) {
      return cache[string];
    } else {
      return cache[string] = callback.call(this, string);
    }
  };
}

module.exports = memoizeStringOnly;

},{}],136:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule monitorCodeUse
 */

"use strict";

var invariant = require("./invariant");

/**
 * Provides open-source compatible instrumentation for monitoring certain API
 * uses before we're ready to issue a warning or refactor. It accepts an event
 * name which may only contain the characters [a-z0-9_] and an optional data
 * object with further information.
 */

function monitorCodeUse(eventName, data) {
  ("production" !== process.env.NODE_ENV ? invariant(
    eventName && !/[^a-z0-9_]/.test(eventName),
    'You must provide an eventName using only the characters [a-z0-9_]'
  ) : invariant(eventName && !/[^a-z0-9_]/.test(eventName)));
}

module.exports = monitorCodeUse;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],137:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule onlyChild
 */
"use strict";

var ReactElement = require("./ReactElement");

var invariant = require("./invariant");

/**
 * Returns the first child in a collection of children and verifies that there
 * is only one child in the collection. The current implementation of this
 * function assumes that a single child gets passed without a wrapper, but the
 * purpose of this helper function is to abstract away the particular structure
 * of children.
 *
 * @param {?object} children Child collection structure.
 * @return {ReactComponent} The first and only `ReactComponent` contained in the
 * structure.
 */
function onlyChild(children) {
  ("production" !== process.env.NODE_ENV ? invariant(
    ReactElement.isValidElement(children),
    'onlyChild must be passed a children with exactly one child.'
  ) : invariant(ReactElement.isValidElement(children)));
  return children;
}

module.exports = onlyChild;

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./invariant":126,"ngpmcQ":176}],138:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule performance
 * @typechecks
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var performance;

if (ExecutionEnvironment.canUseDOM) {
  performance =
    window.performance ||
    window.msPerformance ||
    window.webkitPerformance;
}

module.exports = performance || {};

},{"./ExecutionEnvironment":21}],139:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule performanceNow
 * @typechecks
 */

var performance = require("./performance");

/**
 * Detect if we can use `window.performance.now()` and gracefully fallback to
 * `Date.now()` if it doesn't exist. We need to support Firefox < 15 for now
 * because of Facebook's testing infrastructure.
 */
if (!performance || !performance.now) {
  performance = Date;
}

var performanceNow = performance.now.bind(performance);

module.exports = performanceNow;

},{"./performance":138}],140:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule setInnerHTML
 */

"use strict";

var ExecutionEnvironment = require("./ExecutionEnvironment");

var WHITESPACE_TEST = /^[ \r\n\t\f]/;
var NONVISIBLE_TEST = /<(!--|link|noscript|meta|script|style)[ \r\n\t\f\/>]/;

/**
 * Set the innerHTML property of a node, ensuring that whitespace is preserved
 * even in IE8.
 *
 * @param {DOMElement} node
 * @param {string} html
 * @internal
 */
var setInnerHTML = function(node, html) {
  node.innerHTML = html;
};

if (ExecutionEnvironment.canUseDOM) {
  // IE8: When updating a just created node with innerHTML only leading
  // whitespace is removed. When updating an existing node with innerHTML
  // whitespace in root TextNodes is also collapsed.
  // @see quirksmode.org/bugreports/archives/2004/11/innerhtml_and_t.html

  // Feature detection; only IE8 is known to behave improperly like this.
  var testElement = document.createElement('div');
  testElement.innerHTML = ' ';
  if (testElement.innerHTML === '') {
    setInnerHTML = function(node, html) {
      // Magic theory: IE8 supposedly differentiates between added and updated
      // nodes when processing innerHTML, innerHTML on updated nodes suffers
      // from worse whitespace behavior. Re-adding a node like this triggers
      // the initial and more favorable whitespace behavior.
      // TODO: What to do on a detached node?
      if (node.parentNode) {
        node.parentNode.replaceChild(node, node);
      }

      // We also implement a workaround for non-visible tags disappearing into
      // thin air on IE8, this only happens if there is no visible text
      // in-front of the non-visible tags. Piggyback on the whitespace fix
      // and simply check if any non-visible tags appear in the source.
      if (WHITESPACE_TEST.test(html) ||
          html[0] === '<' && NONVISIBLE_TEST.test(html)) {
        // Recover leading whitespace by temporarily prepending any character.
        // \uFEFF has the potential advantage of being zero-width/invisible.
        node.innerHTML = '\uFEFF' + html;

        // deleteData leaves an empty `TextNode` which offsets the index of all
        // children. Definitely want to avoid this.
        var textNode = node.firstChild;
        if (textNode.data.length === 1) {
          node.removeChild(textNode);
        } else {
          textNode.deleteData(0, 1);
        }
      } else {
        node.innerHTML = html;
      }
    };
  }
}

module.exports = setInnerHTML;

},{"./ExecutionEnvironment":21}],141:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule shallowEqual
 */

"use strict";

/**
 * Performs equality by iterating through keys on an object and returning
 * false when any key has values which are not strictly equal between
 * objA and objB. Returns true when the values of all keys are strictly equal.
 *
 * @return {boolean}
 */
function shallowEqual(objA, objB) {
  if (objA === objB) {
    return true;
  }
  var key;
  // Test for A's keys different from B.
  for (key in objA) {
    if (objA.hasOwnProperty(key) &&
        (!objB.hasOwnProperty(key) || objA[key] !== objB[key])) {
      return false;
    }
  }
  // Test for B's keys missing from A.
  for (key in objB) {
    if (objB.hasOwnProperty(key) && !objA.hasOwnProperty(key)) {
      return false;
    }
  }
  return true;
}

module.exports = shallowEqual;

},{}],142:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule shouldUpdateReactComponent
 * @typechecks static-only
 */

"use strict";

/**
 * Given a `prevElement` and `nextElement`, determines if the existing
 * instance should be updated as opposed to being destroyed or replaced by a new
 * instance. Both arguments are elements. This ensures that this logic can
 * operate on stateless trees without any backing instance.
 *
 * @param {?object} prevElement
 * @param {?object} nextElement
 * @return {boolean} True if the existing instance should be updated.
 * @protected
 */
function shouldUpdateReactComponent(prevElement, nextElement) {
  if (prevElement && nextElement &&
      prevElement.type === nextElement.type &&
      prevElement.key === nextElement.key &&
      prevElement._owner === nextElement._owner) {
    return true;
  }
  return false;
}

module.exports = shouldUpdateReactComponent;

},{}],143:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule toArray
 * @typechecks
 */

var invariant = require("./invariant");

/**
 * Convert array-like objects to arrays.
 *
 * This API assumes the caller knows the contents of the data type. For less
 * well defined inputs use createArrayFrom.
 *
 * @param {object|function|filelist} obj
 * @return {array}
 */
function toArray(obj) {
  var length = obj.length;

  // Some browse builtin objects can report typeof 'function' (e.g. NodeList in
  // old versions of Safari).
  ("production" !== process.env.NODE_ENV ? invariant(
    !Array.isArray(obj) &&
    (typeof obj === 'object' || typeof obj === 'function'),
    'toArray: Array-like object expected'
  ) : invariant(!Array.isArray(obj) &&
  (typeof obj === 'object' || typeof obj === 'function')));

  ("production" !== process.env.NODE_ENV ? invariant(
    typeof length === 'number',
    'toArray: Object needs a length property'
  ) : invariant(typeof length === 'number'));

  ("production" !== process.env.NODE_ENV ? invariant(
    length === 0 ||
    (length - 1) in obj,
    'toArray: Object should have keys for indices'
  ) : invariant(length === 0 ||
  (length - 1) in obj));

  // Old IE doesn't give collections access to hasOwnProperty. Assume inputs
  // without method will throw during the slice call and skip straight to the
  // fallback.
  if (obj.hasOwnProperty) {
    try {
      return Array.prototype.slice.call(obj);
    } catch (e) {
      // IE < 9 does not support Array#slice on collections objects
    }
  }

  // Fall back to copying key by key. This assumes all keys have a value,
  // so will not preserve sparsely populated inputs.
  var ret = Array(length);
  for (var ii = 0; ii < length; ii++) {
    ret[ii] = obj[ii];
  }
  return ret;
}

module.exports = toArray;

}).call(this,require("ngpmcQ"))
},{"./invariant":126,"ngpmcQ":176}],144:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule traverseAllChildren
 */

"use strict";

var ReactElement = require("./ReactElement");
var ReactInstanceHandles = require("./ReactInstanceHandles");

var invariant = require("./invariant");

var SEPARATOR = ReactInstanceHandles.SEPARATOR;
var SUBSEPARATOR = ':';

/**
 * TODO: Test that:
 * 1. `mapChildren` transforms strings and numbers into `ReactTextComponent`.
 * 2. it('should fail when supplied duplicate key', function() {
 * 3. That a single child and an array with one item have the same key pattern.
 * });
 */

var userProvidedKeyEscaperLookup = {
  '=': '=0',
  '.': '=1',
  ':': '=2'
};

var userProvidedKeyEscapeRegex = /[=.:]/g;

function userProvidedKeyEscaper(match) {
  return userProvidedKeyEscaperLookup[match];
}

/**
 * Generate a key string that identifies a component within a set.
 *
 * @param {*} component A component that could contain a manual key.
 * @param {number} index Index that is used if a manual key is not provided.
 * @return {string}
 */
function getComponentKey(component, index) {
  if (component && component.key != null) {
    // Explicit key
    return wrapUserProvidedKey(component.key);
  }
  // Implicit key determined by the index in the set
  return index.toString(36);
}

/**
 * Escape a component key so that it is safe to use in a reactid.
 *
 * @param {*} key Component key to be escaped.
 * @return {string} An escaped string.
 */
function escapeUserProvidedKey(text) {
  return ('' + text).replace(
    userProvidedKeyEscapeRegex,
    userProvidedKeyEscaper
  );
}

/**
 * Wrap a `key` value explicitly provided by the user to distinguish it from
 * implicitly-generated keys generated by a component's index in its parent.
 *
 * @param {string} key Value of a user-provided `key` attribute
 * @return {string}
 */
function wrapUserProvidedKey(key) {
  return '$' + escapeUserProvidedKey(key);
}

/**
 * @param {?*} children Children tree container.
 * @param {!string} nameSoFar Name of the key path so far.
 * @param {!number} indexSoFar Number of children encountered until this point.
 * @param {!function} callback Callback to invoke with each child found.
 * @param {?*} traverseContext Used to pass information throughout the traversal
 * process.
 * @return {!number} The number of children in this subtree.
 */
var traverseAllChildrenImpl =
  function(children, nameSoFar, indexSoFar, callback, traverseContext) {
    var nextName, nextIndex;
    var subtreeCount = 0;  // Count of children found in the current subtree.
    if (Array.isArray(children)) {
      for (var i = 0; i < children.length; i++) {
        var child = children[i];
        nextName = (
          nameSoFar +
          (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
          getComponentKey(child, i)
        );
        nextIndex = indexSoFar + subtreeCount;
        subtreeCount += traverseAllChildrenImpl(
          child,
          nextName,
          nextIndex,
          callback,
          traverseContext
        );
      }
    } else {
      var type = typeof children;
      var isOnlyChild = nameSoFar === '';
      // If it's the only child, treat the name as if it was wrapped in an array
      // so that it's consistent if the number of children grows
      var storageName =
        isOnlyChild ? SEPARATOR + getComponentKey(children, 0) : nameSoFar;
      if (children == null || type === 'boolean') {
        // All of the above are perceived as null.
        callback(traverseContext, null, storageName, indexSoFar);
        subtreeCount = 1;
      } else if (type === 'string' || type === 'number' ||
                 ReactElement.isValidElement(children)) {
        callback(traverseContext, children, storageName, indexSoFar);
        subtreeCount = 1;
      } else if (type === 'object') {
        ("production" !== process.env.NODE_ENV ? invariant(
          !children || children.nodeType !== 1,
          'traverseAllChildren(...): Encountered an invalid child; DOM ' +
          'elements are not valid children of React components.'
        ) : invariant(!children || children.nodeType !== 1));
        for (var key in children) {
          if (children.hasOwnProperty(key)) {
            nextName = (
              nameSoFar + (nameSoFar ? SUBSEPARATOR : SEPARATOR) +
              wrapUserProvidedKey(key) + SUBSEPARATOR +
              getComponentKey(children[key], 0)
            );
            nextIndex = indexSoFar + subtreeCount;
            subtreeCount += traverseAllChildrenImpl(
              children[key],
              nextName,
              nextIndex,
              callback,
              traverseContext
            );
          }
        }
      }
    }
    return subtreeCount;
  };

/**
 * Traverses children that are typically specified as `props.children`, but
 * might also be specified through attributes:
 *
 * - `traverseAllChildren(this.props.children, ...)`
 * - `traverseAllChildren(this.props.leftPanelChildren, ...)`
 *
 * The `traverseContext` is an optional argument that is passed through the
 * entire traversal. It can be used to store accumulations or anything else that
 * the callback might find relevant.
 *
 * @param {?*} children Children tree object.
 * @param {!function} callback To invoke upon traversing each child.
 * @param {?*} traverseContext Context for traversal.
 * @return {!number} The number of children in this subtree.
 */
function traverseAllChildren(children, callback, traverseContext) {
  if (children == null) {
    return 0;
  }

  return traverseAllChildrenImpl(children, '', 0, callback, traverseContext);
}

module.exports = traverseAllChildren;

}).call(this,require("ngpmcQ"))
},{"./ReactElement":52,"./ReactInstanceHandles":60,"./invariant":126,"ngpmcQ":176}],145:[function(require,module,exports){
(function (process){
/**
 * Copyright 2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule warning
 */

"use strict";

var emptyFunction = require("./emptyFunction");

/**
 * Similar to invariant but only logs a warning if the condition is not met.
 * This can be used to log issues in development environments in critical
 * paths. Removing the logging code for production environments will keep the
 * same logic and follow the same code paths.
 */

var warning = emptyFunction;

if ("production" !== process.env.NODE_ENV) {
  warning = function(condition, format ) {for (var args=[],$__0=2,$__1=arguments.length;$__0<$__1;$__0++) args.push(arguments[$__0]);
    if (format === undefined) {
      throw new Error(
        '`warning(condition, format, ...args)` requires a warning ' +
        'message argument'
      );
    }

    if (!condition) {
      var argIndex = 0;
      console.warn('Warning: ' + format.replace(/%s/g, function()  {return args[argIndex++];}));
    }
  };
}

module.exports = warning;

}).call(this,require("ngpmcQ"))
},{"./emptyFunction":107,"ngpmcQ":176}],146:[function(require,module,exports){
module.exports = require('./lib/React');

},{"./lib/React":28}],147:[function(require,module,exports){
module.exports = require('./lib/axios');
},{"./lib/axios":149}],148:[function(require,module,exports){
var defaults = require('./../defaults');
var utils = require('./../utils');
var buildUrl = require('./../helpers/buildUrl');
var cookies = require('./../helpers/cookies');
var parseHeaders = require('./../helpers/parseHeaders');
var transformData = require('./../helpers/transformData');
var urlIsSameOrigin = require('./../helpers/urlIsSameOrigin');

module.exports = function xhrAdapter(resolve, reject, config) {
  // Transform request data
  var data = transformData(
    config.data,
    config.headers,
    config.transformRequest
  );

  // Merge headers
  var headers = utils.merge(
    defaults.headers.common,
    defaults.headers[config.method] || {},
    config.headers || {}
  );

  if (utils.isFormData(data)) {
    delete headers['Content-Type']; // Let the browser set it
  }

  // Create the request
  var request = new(XMLHttpRequest || ActiveXObject)('Microsoft.XMLHTTP');
  request.open(config.method.toUpperCase(), buildUrl(config.url, config.params), true);

  // Listen for ready state
  request.onreadystatechange = function () {
    if (request && request.readyState === 4) {
      // Prepare the response
      var headers = parseHeaders(request.getAllResponseHeaders());
      var response = {
        data: transformData(
          request.responseText,
          headers,
          config.transformResponse
        ),
        status: request.status,
        headers: headers,
        config: config
      };

      // Resolve or reject the Promise based on the status
      (request.status >= 200 && request.status < 300
        ? resolve
        : reject)(response);

      // Clean up request
      request = null;
    }
  };

  // Add xsrf header
  var xsrfValue = urlIsSameOrigin(config.url)
    ? cookies.read(config.xsrfCookieName || defaults.xsrfCookieName)
    : undefined;
  if (xsrfValue) {
    headers[config.xsrfHeaderName || defaults.xsrfHeaderName] = xsrfValue;
  }

  // Add headers to the request
  utils.forEach(headers, function (val, key) {
    // Remove Content-Type if data is undefined
    if (!data && key.toLowerCase() === 'content-type') {
      delete headers[key];
    }
    // Otherwise add header to the request
    else {
      request.setRequestHeader(key, val);
    }
  });

  // Add withCredentials to request if needed
  if (config.withCredentials) {
    request.withCredentials = true;
  }

  // Add responseType to request if needed
  if (config.responseType) {
    try {
      request.responseType = config.responseType;
    } catch (e) {
      if (request.responseType !== 'json') {
        throw e;
      }
    }
  }

  if (utils.isArrayBuffer(data)) {
    data = new DataView(data);
  }

  // Send the request
  request.send(data);
};
},{"./../defaults":150,"./../helpers/buildUrl":151,"./../helpers/cookies":152,"./../helpers/parseHeaders":153,"./../helpers/transformData":155,"./../helpers/urlIsSameOrigin":156,"./../utils":157}],149:[function(require,module,exports){
(function (process){
var Promise = require('es6-promise').Promise;
var defaults = require('./defaults');
var utils = require('./utils');

var axios = module.exports = function axios(config) {
  config = utils.merge({
    method: 'get',
    headers: {},
    transformRequest: defaults.transformRequest,
    transformResponse: defaults.transformResponse
  }, config);

  // Don't allow overriding defaults.withCredentials
  config.withCredentials = config.withCredentials || defaults.withCredentials;

  var serverRequest = function (config) {
    return new Promise(function (resolve, reject) {
      try {
        // For browsers use XHR adapter
        if (typeof window !== 'undefined') {
          require('./adapters/xhr')(resolve, reject, config);
        }
        // For node use HTTP adapter
        else if (typeof process !== 'undefined') {
          require('./adapters/http')(resolve, reject, config);
        }
      } catch (e) {
        reject(e);
      }
    });
  };

  function deprecatedMethod(method, instead, docs) {
    try {
      console.warn(
        'DEPRECATED method `' + method + '`.' +
        (instead ? ' Use `' + instead + '` instead.' : '') +
        ' This method will be removed in a future release.');

      if (docs) {
        console.warn('For more information about usage see ' + docs);
      }
    } catch (e) {}
  }

  var chain = [serverRequest, undefined];
  var promise = Promise.resolve(config);

  utils.forEach(axios.interceptors.request.handlers, function (interceptor) {
    chain.unshift(interceptor.request, interceptor.requestError);
  });

  utils.forEach(axios.interceptors.response.handlers, function (interceptor) {
    chain.push(interceptor.response, interceptor.responseError);
  });

  while (chain.length) {
    var thenFn = chain.shift();
    var rejectFn = chain.shift();

    promise = promise.then(thenFn, rejectFn);
  }

  // Provide alias for success
  promise.success = function success(fn) {
    deprecatedMethod('success', 'then', 'https://github.com/mzabriskie/axios/blob/master/README.md#response-api');

    promise.then(function(response) {
      fn(response.data, response.status, response.headers, response.config);
    });
    return promise;
  };

  // Provide alias for error
  promise.error = function error(fn) {
    deprecatedMethod('error', 'catch', 'https://github.com/mzabriskie/axios/blob/master/README.md#response-api');

    promise.then(null, function(response) {
      fn(response.data, response.status, response.headers, response.config);
    });
    return promise;
  };

  return promise;
};

// Expose defaults
axios.defaults = defaults;

// Expose all/spread
axios.all = function (promises) {
  return Promise.all(promises);
};
axios.spread = require('./helpers/spread');

// interceptors
axios.interceptors = {
  request: {
    handlers: [],
    use: function (thenFn, rejectFn) {
      axios.interceptors.request.handlers.push({ request: thenFn, requestError: rejectFn });
    }
  },
  response: {
    handlers: [],
    use: function (thenFn, rejectFn) {
      axios.interceptors.response.handlers.push({ response: thenFn, responseError: rejectFn });
    }
  }
};

// Provide aliases for supported request methods
createShortMethods('delete', 'get', 'head');
createShortMethodsWithData('post', 'put', 'patch');

function createShortMethods() {
  utils.forEach(arguments, function (method) {
    axios[method] = function (url, config) {
      return axios(utils.merge(config || {}, {
        method: method,
        url: url
      }));
    };
  });
}

function createShortMethodsWithData() {
  utils.forEach(arguments, function (method) {
    axios[method] = function (url, data, config) {
      return axios(utils.merge(config || {}, {
        method: method,
        url: url,
        data: data
      }));
    };
  });
}

}).call(this,require("ngpmcQ"))
},{"./adapters/http":148,"./adapters/xhr":148,"./defaults":150,"./helpers/spread":154,"./utils":157,"es6-promise":158,"ngpmcQ":176}],150:[function(require,module,exports){
'use strict';

var utils = require('./utils');

var JSON_START = /^\s*(\[|\{[^\{])/;
var JSON_END = /[\}\]]\s*$/;
var PROTECTION_PREFIX = /^\)\]\}',?\n/;
var DEFAULT_CONTENT_TYPE = {
  'Content-Type': 'application/x-www-form-urlencoded'
};

module.exports = {
  transformRequest: [function (data, headers) {
    if (utils.isArrayBuffer(data)) {
      return data;
    }
    if (utils.isArrayBufferView(data)) {
      return data.buffer;
    }
    if (utils.isObject(data) && !utils.isFile(data) && !utils.isBlob(data)) {
      // Set application/json if no Content-Type has been specified
      if (!utils.isUndefined(headers) && utils.isUndefined(headers['Content-Type'])) {
        headers['Content-Type'] = 'application/json;charset=utf-8';
      }
      return JSON.stringify(data);
    }
    return data;
  }],

  transformResponse: [function (data) {
    if (typeof data === 'string') {
      data = data.replace(PROTECTION_PREFIX, '');
      if (JSON_START.test(data) && JSON_END.test(data)) {
        data = JSON.parse(data);
      }
    }
    return data;
  }],

  headers: {
    common: {
      'Accept': 'application/json, text/plain, */*'
    },
    patch: utils.merge(DEFAULT_CONTENT_TYPE),
    post: utils.merge(DEFAULT_CONTENT_TYPE),
    put: utils.merge(DEFAULT_CONTENT_TYPE)
  },

  xsrfCookieName: 'XSRF-TOKEN',
  xsrfHeaderName: 'X-XSRF-TOKEN'
};
},{"./utils":157}],151:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

function encode(val) {
  return encodeURIComponent(val).
    replace(/%40/gi, '@').
    replace(/%3A/gi, ':').
    replace(/%24/g, '$').
    replace(/%2C/gi, ',').
    replace(/%20/g, '+');
}

module.exports = function buildUrl(url, params) {
  if (!params) {
    return url;
  }

  var parts = [];

  utils.forEach(params, function (val, key) {
    if (val === null || typeof val === 'undefined') {
      return;
    }
    if (!utils.isArray(val)) {
      val = [val];
    }

    utils.forEach(val, function (v) {
      if (utils.isDate(v)) {
        v = v.toISOString();
      }
      else if (utils.isObject(v)) {
        v = JSON.stringify(v);
      }
      parts.push(encode(key) + '=' + encode(v));
    });
  });

  if (parts.length > 0) {
    url += (url.indexOf('?') === -1 ? '?' : '&') + parts.join('&');
  }

  return url;
};
},{"./../utils":157}],152:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

module.exports = {
  write: function write(name, value, expires, path, domain, secure) {
    var cookie = [];
    cookie.push(name + '=' + encodeURIComponent(value));

    if (utils.isNumber(expires)) {
      cookie.push('expires=' + new Date(expires).toGMTString());
    }

    if (utils.isString(path)) {
      cookie.push('path=' + path);
    }

    if (utils.isString(domain)) {
      cookie.push('domain=' + domain);
    }

    if (secure === true) {
      cookie.push('secure');
    }

    document.cookie = cookie.join('; ');
  },

  read: function read(name) {
    var match = document.cookie.match(new RegExp('(^|;\\s*)(' + name + ')=([^;]*)'));
    return (match ? decodeURIComponent(match[3]) : null);
  },

  remove: function remove(name) {
    this.write(name, '', Date.now() - 86400000);
  }
};
},{"./../utils":157}],153:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

/**
 * Parse headers into an object
 *
 * ```
 * Date: Wed, 27 Aug 2014 08:58:49 GMT
 * Content-Type: application/json
 * Connection: keep-alive
 * Transfer-Encoding: chunked
 * ```
 *
 * @param {String} headers Headers needing to be parsed
 * @returns {Object} Headers parsed into an object
 */
module.exports = function parseHeaders(headers) {
  var parsed = {}, key, val, i;

  if (!headers) return parsed;

  utils.forEach(headers.split('\n'), function(line) {
    i = line.indexOf(':');
    key = utils.trim(line.substr(0, i)).toLowerCase();
    val = utils.trim(line.substr(i + 1));

    if (key) {
      parsed[key] = parsed[key] ? parsed[key] + ', ' + val : val;
    }
  });

  return parsed;
};
},{"./../utils":157}],154:[function(require,module,exports){
/**
 * Syntactic sugar for invoking a function and expanding an array for arguments.
 *
 * Common use case would be to use `Function.prototype.apply`.
 *
 *  ```js
 *  function f(x, y, z) {}
 *  var args = [1, 2, 3];
 *  f.apply(null, args);
 *  ```
 *
 * With `spread` this example can be re-written.
 *
 *  ```js
 *  spread(function(x, y, z) {})([1, 2, 3]);
 *  ```
 *
 * @param {Function} callback
 * @returns {Function}
 */
module.exports = function spread(callback) {
  return function (arr) {
    callback.apply(null, arr);
  };
};
},{}],155:[function(require,module,exports){
'use strict';

var utils = require('./../utils');

/**
 * Transform the data for a request or a response
 *
 * @param {Object|String} data The data to be transformed
 * @param {Array} headers The headers for the request or response
 * @param {Array|Function} fns A single function or Array of functions
 * @returns {*} The resulting transformed data
 */
module.exports = function transformData(data, headers, fns) {
  utils.forEach(fns, function (fn) {
    data = fn(data, headers);
  });

  return data;
};
},{"./../utils":157}],156:[function(require,module,exports){
'use strict';

var msie = /(msie|trident)/i.test(navigator.userAgent);
var utils = require('./../utils');
var urlParsingNode = document.createElement('a');
var originUrl = urlResolve(window.location.href);

/**
 * Parse a URL to discover it's components
 *
 * @param {String} url The URL to be parsed
 * @returns {Object}
 */
function urlResolve(url) {
  var href = url;

  if (msie) {
    // IE needs attribute set twice to normalize properties
    urlParsingNode.setAttribute('href', href);
    href = urlParsingNode.href;
  }

  urlParsingNode.setAttribute('href', href);

  // urlParsingNode provides the UrlUtils interface - http://url.spec.whatwg.org/#urlutils
  return {
    href: urlParsingNode.href,
    protocol: urlParsingNode.protocol ? urlParsingNode.protocol.replace(/:$/, '') : '',
    host: urlParsingNode.host,
    search: urlParsingNode.search ? urlParsingNode.search.replace(/^\?/, '') : '',
    hash: urlParsingNode.hash ? urlParsingNode.hash.replace(/^#/, '') : '',
    hostname: urlParsingNode.hostname,
    port: urlParsingNode.port,
    pathname: (urlParsingNode.pathname.charAt(0) === '/')
      ? urlParsingNode.pathname
      : '/' + urlParsingNode.pathname
  };
}

/**
 * Determine if a URL shares the same origin as the current location
 *
 * @param {String} requestUrl The URL to test
 * @returns {boolean} True if URL shares the same origin, otherwise false
 */
module.exports = function urlIsSameOrigin(requestUrl) {
  var parsed = (utils.isString(requestUrl)) ? urlResolve(requestUrl) : requestUrl;
  return (parsed.protocol === originUrl.protocol &&
        parsed.host === originUrl.host);
};
},{"./../utils":157}],157:[function(require,module,exports){
// utils is a library of generic helper functions non-specific to axios

var toString = Object.prototype.toString;

/**
 * Determine if a value is an Array
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an Array, otherwise false
 */
function isArray(val) {
  return toString.call(val) === '[object Array]';
}

/**
 * Determine if a value is an ArrayBuffer
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an ArrayBuffer, otherwise false
 */
function isArrayBuffer(val) {
  return toString.call(val) === '[object ArrayBuffer]';
}

/**
 * Determine if a value is a FormData
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an FormData, otherwise false
 */
function isFormData(val) {
  return toString.call(val) === '[object FormData]';
}

/**
 * Determine if a value is a view on an ArrayBuffer
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a view on an ArrayBuffer, otherwise false
 */
function isArrayBufferView(val) {
  if ((typeof ArrayBuffer !== 'undefined') && (ArrayBuffer.isView)) {
    return ArrayBuffer.isView(val);
  } else {
    return (val) && (val.buffer) && (val.buffer instanceof ArrayBuffer);
  }
}

/**
 * Determine if a value is a String
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a String, otherwise false
 */
function isString(val) {
  return typeof val === 'string';
}

/**
 * Determine if a value is a Number
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Number, otherwise false
 */
function isNumber(val) {
  return typeof val === 'number';
}

/**
 * Determine if a value is undefined
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if the value is undefined, otherwise false
 */
function isUndefined(val) {
  return typeof val === 'undefined';
}

/**
 * Determine if a value is an Object
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is an Object, otherwise false
 */
function isObject(val) {
  return val !== null && typeof val === 'object';
}

/**
 * Determine if a value is a Date
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Date, otherwise false
 */
function isDate(val) {
  return toString.call(val) === '[object Date]';
}

/**
 * Determine if a value is a File
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a File, otherwise false
 */
function isFile(val) {
  return toString.call(val) === '[object File]';
}

/**
 * Determine if a value is a Blob
 *
 * @param {Object} val The value to test
 * @returns {boolean} True if value is a Blob, otherwise false
 */
function isBlob(val) {
  return toString.call(val) === '[object Blob]';
}

/**
 * Trim excess whitespace off the beginning and end of a string
 *
 * @param {String} str The String to trim
 * @returns {String} The String freed of excess whitespace
 */
function trim(str) {
  return str.replace(/^\s*/, '').replace(/\s*$/, '');
}

/**
 * Iterate over an Array or an Object invoking a function for each item.
 *
 * If `obj` is an Array or arguments callback will be called passing
 * the value, index, and complete array for each item.
 *
 * If 'obj' is an Object callback will be called passing
 * the value, key, and complete object for each property.
 *
 * @param {Object|Array} obj The object to iterate
 * @param {Function} fn The callback to invoke for each item
 */
function forEach(obj, fn) {
  // Don't bother if no value provided
  if (obj === null || typeof obj === 'undefined') {
    return;
  }

  // Check if obj is array-like
  var isArray = obj.constructor === Array || typeof obj.callee === 'function';

  // Force an array if not already something iterable
  if (typeof obj !== 'object' && !isArray) {
    obj = [obj];
  }

  // Iterate over array values
  if (isArray) {
    for (var i=0, l=obj.length; i<l; i++) {
      fn.call(null, obj[i], i, obj);
    }
  }
  // Iterate over object keys
  else {
    for (var key in obj) {
      if (obj.hasOwnProperty(key)) {
        fn.call(null, obj[key], key, obj);
      }
    }
  }
}

/**
 * Accepts varargs expecting each argument to be an object, then
 * immutably merges the properties of each object and returns result.
 *
 * When multiple objects contain the same key the later object in
 * the arguments list will take precedence.
 *
 * Example:
 *
 * ```js
 * var result = merge({foo: 123}, {foo: 456});
 * console.log(result.foo); // outputs 456
 * ```
 *
 * @param {Object} obj1 Object to merge
 * @returns {Object} Result of all merge properties
 */
function merge(obj1/*, obj2, obj3, ...*/) {
  var result = {};
  forEach(arguments, function (obj) {
    forEach(obj, function (val, key) {
      result[key] = val;
    });
  });
  return result;
}

module.exports = {
  isArray: isArray,
  isArrayBuffer: isArrayBuffer,
  isFormData: isFormData,
  isArrayBufferView: isArrayBufferView,
  isString: isString,
  isNumber: isNumber,
  isObject: isObject,
  isUndefined: isUndefined,
  isDate: isDate,
  isFile: isFile,
  isBlob: isBlob,
  forEach: forEach,
  merge: merge,
  trim: trim
};
},{}],158:[function(require,module,exports){
"use strict";
var Promise = require("./promise/promise").Promise;
var polyfill = require("./promise/polyfill").polyfill;
exports.Promise = Promise;
exports.polyfill = polyfill;
},{"./promise/polyfill":162,"./promise/promise":163}],159:[function(require,module,exports){
"use strict";
/* global toString */

var isArray = require("./utils").isArray;
var isFunction = require("./utils").isFunction;

/**
  Returns a promise that is fulfilled when all the given promises have been
  fulfilled, or rejected if any of them become rejected. The return promise
  is fulfilled with an array that gives all the values in the order they were
  passed in the `promises` array argument.

  Example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.resolve(2);
  var promise3 = RSVP.resolve(3);
  var promises = [ promise1, promise2, promise3 ];

  RSVP.all(promises).then(function(array){
    // The array here would be [ 1, 2, 3 ];
  });
  ```

  If any of the `promises` given to `RSVP.all` are rejected, the first promise
  that is rejected will be given as an argument to the returned promises's
  rejection handler. For example:

  Example:

  ```javascript
  var promise1 = RSVP.resolve(1);
  var promise2 = RSVP.reject(new Error("2"));
  var promise3 = RSVP.reject(new Error("3"));
  var promises = [ promise1, promise2, promise3 ];

  RSVP.all(promises).then(function(array){
    // Code here never runs because there are rejected promises!
  }, function(error) {
    // error.message === "2"
  });
  ```

  @method all
  @for RSVP
  @param {Array} promises
  @param {String} label
  @return {Promise} promise that is fulfilled when all `promises` have been
  fulfilled, or rejected if any of them become rejected.
*/
function all(promises) {
  /*jshint validthis:true */
  var Promise = this;

  if (!isArray(promises)) {
    throw new TypeError('You must pass an array to all.');
  }

  return new Promise(function(resolve, reject) {
    var results = [], remaining = promises.length,
    promise;

    if (remaining === 0) {
      resolve([]);
    }

    function resolver(index) {
      return function(value) {
        resolveAll(index, value);
      };
    }

    function resolveAll(index, value) {
      results[index] = value;
      if (--remaining === 0) {
        resolve(results);
      }
    }

    for (var i = 0; i < promises.length; i++) {
      promise = promises[i];

      if (promise && isFunction(promise.then)) {
        promise.then(resolver(i), reject);
      } else {
        resolveAll(i, promise);
      }
    }
  });
}

exports.all = all;
},{"./utils":167}],160:[function(require,module,exports){
(function (process,global){
"use strict";
var browserGlobal = (typeof window !== 'undefined') ? window : {};
var BrowserMutationObserver = browserGlobal.MutationObserver || browserGlobal.WebKitMutationObserver;
var local = (typeof global !== 'undefined') ? global : (this === undefined? window:this);

// node
function useNextTick() {
  return function() {
    process.nextTick(flush);
  };
}

function useMutationObserver() {
  var iterations = 0;
  var observer = new BrowserMutationObserver(flush);
  var node = document.createTextNode('');
  observer.observe(node, { characterData: true });

  return function() {
    node.data = (iterations = ++iterations % 2);
  };
}

function useSetTimeout() {
  return function() {
    local.setTimeout(flush, 1);
  };
}

var queue = [];
function flush() {
  for (var i = 0; i < queue.length; i++) {
    var tuple = queue[i];
    var callback = tuple[0], arg = tuple[1];
    callback(arg);
  }
  queue = [];
}

var scheduleFlush;

// Decide what async method to use to triggering processing of queued callbacks:
if (typeof process !== 'undefined' && {}.toString.call(process) === '[object process]') {
  scheduleFlush = useNextTick();
} else if (BrowserMutationObserver) {
  scheduleFlush = useMutationObserver();
} else {
  scheduleFlush = useSetTimeout();
}

function asap(callback, arg) {
  var length = queue.push([callback, arg]);
  if (length === 1) {
    // If length is 1, that means that we need to schedule an async flush.
    // If additional callbacks are queued before the queue is flushed, they
    // will be processed by this flush that we are scheduling.
    scheduleFlush();
  }
}

exports.asap = asap;
}).call(this,require("ngpmcQ"),typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"ngpmcQ":176}],161:[function(require,module,exports){
"use strict";
var config = {
  instrument: false
};

function configure(name, value) {
  if (arguments.length === 2) {
    config[name] = value;
  } else {
    return config[name];
  }
}

exports.config = config;
exports.configure = configure;
},{}],162:[function(require,module,exports){
(function (global){
"use strict";
/*global self*/
var RSVPPromise = require("./promise").Promise;
var isFunction = require("./utils").isFunction;

function polyfill() {
  var local;

  if (typeof global !== 'undefined') {
    local = global;
  } else if (typeof window !== 'undefined' && window.document) {
    local = window;
  } else {
    local = self;
  }

  var es6PromiseSupport = 
    "Promise" in local &&
    // Some of these methods are missing from
    // Firefox/Chrome experimental implementations
    "resolve" in local.Promise &&
    "reject" in local.Promise &&
    "all" in local.Promise &&
    "race" in local.Promise &&
    // Older version of the spec had a resolver object
    // as the arg rather than a function
    (function() {
      var resolve;
      new local.Promise(function(r) { resolve = r; });
      return isFunction(resolve);
    }());

  if (!es6PromiseSupport) {
    local.Promise = RSVPPromise;
  }
}

exports.polyfill = polyfill;
}).call(this,typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./promise":163,"./utils":167}],163:[function(require,module,exports){
"use strict";
var config = require("./config").config;
var configure = require("./config").configure;
var objectOrFunction = require("./utils").objectOrFunction;
var isFunction = require("./utils").isFunction;
var now = require("./utils").now;
var all = require("./all").all;
var race = require("./race").race;
var staticResolve = require("./resolve").resolve;
var staticReject = require("./reject").reject;
var asap = require("./asap").asap;

var counter = 0;

config.async = asap; // default async is asap;

function Promise(resolver) {
  if (!isFunction(resolver)) {
    throw new TypeError('You must pass a resolver function as the first argument to the promise constructor');
  }

  if (!(this instanceof Promise)) {
    throw new TypeError("Failed to construct 'Promise': Please use the 'new' operator, this object constructor cannot be called as a function.");
  }

  this._subscribers = [];

  invokeResolver(resolver, this);
}

function invokeResolver(resolver, promise) {
  function resolvePromise(value) {
    resolve(promise, value);
  }

  function rejectPromise(reason) {
    reject(promise, reason);
  }

  try {
    resolver(resolvePromise, rejectPromise);
  } catch(e) {
    rejectPromise(e);
  }
}

function invokeCallback(settled, promise, callback, detail) {
  var hasCallback = isFunction(callback),
      value, error, succeeded, failed;

  if (hasCallback) {
    try {
      value = callback(detail);
      succeeded = true;
    } catch(e) {
      failed = true;
      error = e;
    }
  } else {
    value = detail;
    succeeded = true;
  }

  if (handleThenable(promise, value)) {
    return;
  } else if (hasCallback && succeeded) {
    resolve(promise, value);
  } else if (failed) {
    reject(promise, error);
  } else if (settled === FULFILLED) {
    resolve(promise, value);
  } else if (settled === REJECTED) {
    reject(promise, value);
  }
}

var PENDING   = void 0;
var SEALED    = 0;
var FULFILLED = 1;
var REJECTED  = 2;

function subscribe(parent, child, onFulfillment, onRejection) {
  var subscribers = parent._subscribers;
  var length = subscribers.length;

  subscribers[length] = child;
  subscribers[length + FULFILLED] = onFulfillment;
  subscribers[length + REJECTED]  = onRejection;
}

function publish(promise, settled) {
  var child, callback, subscribers = promise._subscribers, detail = promise._detail;

  for (var i = 0; i < subscribers.length; i += 3) {
    child = subscribers[i];
    callback = subscribers[i + settled];

    invokeCallback(settled, child, callback, detail);
  }

  promise._subscribers = null;
}

Promise.prototype = {
  constructor: Promise,

  _state: undefined,
  _detail: undefined,
  _subscribers: undefined,

  then: function(onFulfillment, onRejection) {
    var promise = this;

    var thenPromise = new this.constructor(function() {});

    if (this._state) {
      var callbacks = arguments;
      config.async(function invokePromiseCallback() {
        invokeCallback(promise._state, thenPromise, callbacks[promise._state - 1], promise._detail);
      });
    } else {
      subscribe(this, thenPromise, onFulfillment, onRejection);
    }

    return thenPromise;
  },

  'catch': function(onRejection) {
    return this.then(null, onRejection);
  }
};

Promise.all = all;
Promise.race = race;
Promise.resolve = staticResolve;
Promise.reject = staticReject;

function handleThenable(promise, value) {
  var then = null,
  resolved;

  try {
    if (promise === value) {
      throw new TypeError("A promises callback cannot return that same promise.");
    }

    if (objectOrFunction(value)) {
      then = value.then;

      if (isFunction(then)) {
        then.call(value, function(val) {
          if (resolved) { return true; }
          resolved = true;

          if (value !== val) {
            resolve(promise, val);
          } else {
            fulfill(promise, val);
          }
        }, function(val) {
          if (resolved) { return true; }
          resolved = true;

          reject(promise, val);
        });

        return true;
      }
    }
  } catch (error) {
    if (resolved) { return true; }
    reject(promise, error);
    return true;
  }

  return false;
}

function resolve(promise, value) {
  if (promise === value) {
    fulfill(promise, value);
  } else if (!handleThenable(promise, value)) {
    fulfill(promise, value);
  }
}

function fulfill(promise, value) {
  if (promise._state !== PENDING) { return; }
  promise._state = SEALED;
  promise._detail = value;

  config.async(publishFulfillment, promise);
}

function reject(promise, reason) {
  if (promise._state !== PENDING) { return; }
  promise._state = SEALED;
  promise._detail = reason;

  config.async(publishRejection, promise);
}

function publishFulfillment(promise) {
  publish(promise, promise._state = FULFILLED);
}

function publishRejection(promise) {
  publish(promise, promise._state = REJECTED);
}

exports.Promise = Promise;
},{"./all":159,"./asap":160,"./config":161,"./race":164,"./reject":165,"./resolve":166,"./utils":167}],164:[function(require,module,exports){
"use strict";
/* global toString */
var isArray = require("./utils").isArray;

/**
  `RSVP.race` allows you to watch a series of promises and act as soon as the
  first promise given to the `promises` argument fulfills or rejects.

  Example:

  ```javascript
  var promise1 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 1");
    }, 200);
  });

  var promise2 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 2");
    }, 100);
  });

  RSVP.race([promise1, promise2]).then(function(result){
    // result === "promise 2" because it was resolved before promise1
    // was resolved.
  });
  ```

  `RSVP.race` is deterministic in that only the state of the first completed
  promise matters. For example, even if other promises given to the `promises`
  array argument are resolved, but the first completed promise has become
  rejected before the other promises became fulfilled, the returned promise
  will become rejected:

  ```javascript
  var promise1 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      resolve("promise 1");
    }, 200);
  });

  var promise2 = new RSVP.Promise(function(resolve, reject){
    setTimeout(function(){
      reject(new Error("promise 2"));
    }, 100);
  });

  RSVP.race([promise1, promise2]).then(function(result){
    // Code here never runs because there are rejected promises!
  }, function(reason){
    // reason.message === "promise2" because promise 2 became rejected before
    // promise 1 became fulfilled
  });
  ```

  @method race
  @for RSVP
  @param {Array} promises array of promises to observe
  @param {String} label optional string for describing the promise returned.
  Useful for tooling.
  @return {Promise} a promise that becomes fulfilled with the value the first
  completed promises is resolved with if the first completed promise was
  fulfilled, or rejected with the reason that the first completed promise
  was rejected with.
*/
function race(promises) {
  /*jshint validthis:true */
  var Promise = this;

  if (!isArray(promises)) {
    throw new TypeError('You must pass an array to race.');
  }
  return new Promise(function(resolve, reject) {
    var results = [], promise;

    for (var i = 0; i < promises.length; i++) {
      promise = promises[i];

      if (promise && typeof promise.then === 'function') {
        promise.then(resolve, reject);
      } else {
        resolve(promise);
      }
    }
  });
}

exports.race = race;
},{"./utils":167}],165:[function(require,module,exports){
"use strict";
/**
  `RSVP.reject` returns a promise that will become rejected with the passed
  `reason`. `RSVP.reject` is essentially shorthand for the following:

  ```javascript
  var promise = new RSVP.Promise(function(resolve, reject){
    reject(new Error('WHOOPS'));
  });

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  Instead of writing the above, your code now simply becomes the following:

  ```javascript
  var promise = RSVP.reject(new Error('WHOOPS'));

  promise.then(function(value){
    // Code here doesn't run because the promise is rejected!
  }, function(reason){
    // reason.message === 'WHOOPS'
  });
  ```

  @method reject
  @for RSVP
  @param {Any} reason value that the returned promise will be rejected with.
  @param {String} label optional string for identifying the returned promise.
  Useful for tooling.
  @return {Promise} a promise that will become rejected with the given
  `reason`.
*/
function reject(reason) {
  /*jshint validthis:true */
  var Promise = this;

  return new Promise(function (resolve, reject) {
    reject(reason);
  });
}

exports.reject = reject;
},{}],166:[function(require,module,exports){
"use strict";
function resolve(value) {
  /*jshint validthis:true */
  if (value && typeof value === 'object' && value.constructor === this) {
    return value;
  }

  var Promise = this;

  return new Promise(function(resolve) {
    resolve(value);
  });
}

exports.resolve = resolve;
},{}],167:[function(require,module,exports){
"use strict";
function objectOrFunction(x) {
  return isFunction(x) || (typeof x === "object" && x !== null);
}

function isFunction(x) {
  return typeof x === "function";
}

function isArray(x) {
  return Object.prototype.toString.call(x) === "[object Array]";
}

// Date.now is not available in browsers < IE9
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/now#Compatibility
var now = Date.now || function() { return new Date().getTime(); };


exports.objectOrFunction = objectOrFunction;
exports.isFunction = isFunction;
exports.isArray = isArray;
exports.now = now;
},{}],168:[function(require,module,exports){
/*! @license Firebase v2.4.2
    License: https://www.firebase.com/terms/terms-of-service.html */
(function() {var h,n=this;function p(a){return void 0!==a}function aa(){}function ba(a){a.yb=function(){return a.zf?a.zf:a.zf=new a}}
function ca(a){var b=typeof a;if("object"==b)if(a){if(a instanceof Array)return"array";if(a instanceof Object)return b;var c=Object.prototype.toString.call(a);if("[object Window]"==c)return"object";if("[object Array]"==c||"number"==typeof a.length&&"undefined"!=typeof a.splice&&"undefined"!=typeof a.propertyIsEnumerable&&!a.propertyIsEnumerable("splice"))return"array";if("[object Function]"==c||"undefined"!=typeof a.call&&"undefined"!=typeof a.propertyIsEnumerable&&!a.propertyIsEnumerable("call"))return"function"}else return"null";
else if("function"==b&&"undefined"==typeof a.call)return"object";return b}function da(a){return"array"==ca(a)}function ea(a){var b=ca(a);return"array"==b||"object"==b&&"number"==typeof a.length}function q(a){return"string"==typeof a}function fa(a){return"number"==typeof a}function r(a){return"function"==ca(a)}function ga(a){var b=typeof a;return"object"==b&&null!=a||"function"==b}function ha(a,b,c){return a.call.apply(a.bind,arguments)}
function ia(a,b,c){if(!a)throw Error();if(2<arguments.length){var d=Array.prototype.slice.call(arguments,2);return function(){var c=Array.prototype.slice.call(arguments);Array.prototype.unshift.apply(c,d);return a.apply(b,c)}}return function(){return a.apply(b,arguments)}}function u(a,b,c){u=Function.prototype.bind&&-1!=Function.prototype.bind.toString().indexOf("native code")?ha:ia;return u.apply(null,arguments)}var ja=Date.now||function(){return+new Date};
function ka(a,b){function c(){}c.prototype=b.prototype;a.ph=b.prototype;a.prototype=new c;a.prototype.constructor=a;a.lh=function(a,c,f){for(var g=Array(arguments.length-2),k=2;k<arguments.length;k++)g[k-2]=arguments[k];return b.prototype[c].apply(a,g)}};function la(a){if(Error.captureStackTrace)Error.captureStackTrace(this,la);else{var b=Error().stack;b&&(this.stack=b)}a&&(this.message=String(a))}ka(la,Error);la.prototype.name="CustomError";function v(a,b){for(var c in a)b.call(void 0,a[c],c,a)}function ma(a,b){var c={},d;for(d in a)c[d]=b.call(void 0,a[d],d,a);return c}function na(a,b){for(var c in a)if(!b.call(void 0,a[c],c,a))return!1;return!0}function oa(a){var b=0,c;for(c in a)b++;return b}function pa(a){for(var b in a)return b}function qa(a){var b=[],c=0,d;for(d in a)b[c++]=a[d];return b}function ra(a){var b=[],c=0,d;for(d in a)b[c++]=d;return b}function sa(a,b){for(var c in a)if(a[c]==b)return!0;return!1}
function ta(a,b,c){for(var d in a)if(b.call(c,a[d],d,a))return d}function ua(a,b){var c=ta(a,b,void 0);return c&&a[c]}function va(a){for(var b in a)return!1;return!0}function wa(a){var b={},c;for(c in a)b[c]=a[c];return b}var xa="constructor hasOwnProperty isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf".split(" ");
function ya(a,b){for(var c,d,e=1;e<arguments.length;e++){d=arguments[e];for(c in d)a[c]=d[c];for(var f=0;f<xa.length;f++)c=xa[f],Object.prototype.hasOwnProperty.call(d,c)&&(a[c]=d[c])}};function za(a){a=String(a);if(/^\s*$/.test(a)?0:/^[\],:{}\s\u2028\u2029]*$/.test(a.replace(/\\["\\\/bfnrtu]/g,"@").replace(/"[^"\\\n\r\u2028\u2029\x00-\x08\x0a-\x1f]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g,"]").replace(/(?:^|:|,)(?:[\s\u2028\u2029]*\[)+/g,"")))try{return eval("("+a+")")}catch(b){}throw Error("Invalid JSON string: "+a);}function Aa(){this.Vd=void 0}
function Ba(a,b,c){switch(typeof b){case "string":Ca(b,c);break;case "number":c.push(isFinite(b)&&!isNaN(b)?b:"null");break;case "boolean":c.push(b);break;case "undefined":c.push("null");break;case "object":if(null==b){c.push("null");break}if(da(b)){var d=b.length;c.push("[");for(var e="",f=0;f<d;f++)c.push(e),e=b[f],Ba(a,a.Vd?a.Vd.call(b,String(f),e):e,c),e=",";c.push("]");break}c.push("{");d="";for(f in b)Object.prototype.hasOwnProperty.call(b,f)&&(e=b[f],"function"!=typeof e&&(c.push(d),Ca(f,c),
c.push(":"),Ba(a,a.Vd?a.Vd.call(b,f,e):e,c),d=","));c.push("}");break;case "function":break;default:throw Error("Unknown type: "+typeof b);}}var Da={'"':'\\"',"\\":"\\\\","/":"\\/","\b":"\\b","\f":"\\f","\n":"\\n","\r":"\\r","\t":"\\t","\x0B":"\\u000b"},Ea=/\uffff/.test("\uffff")?/[\\\"\x00-\x1f\x7f-\uffff]/g:/[\\\"\x00-\x1f\x7f-\xff]/g;
function Ca(a,b){b.push('"',a.replace(Ea,function(a){if(a in Da)return Da[a];var b=a.charCodeAt(0),e="\\u";16>b?e+="000":256>b?e+="00":4096>b&&(e+="0");return Da[a]=e+b.toString(16)}),'"')};function Fa(){return Math.floor(2147483648*Math.random()).toString(36)+Math.abs(Math.floor(2147483648*Math.random())^ja()).toString(36)};var w;a:{var Ga=n.navigator;if(Ga){var Ha=Ga.userAgent;if(Ha){w=Ha;break a}}w=""};function Ia(){this.Ya=-1};function Ja(){this.Ya=-1;this.Ya=64;this.P=[];this.pe=[];this.eg=[];this.Od=[];this.Od[0]=128;for(var a=1;a<this.Ya;++a)this.Od[a]=0;this.ge=this.ec=0;this.reset()}ka(Ja,Ia);Ja.prototype.reset=function(){this.P[0]=1732584193;this.P[1]=4023233417;this.P[2]=2562383102;this.P[3]=271733878;this.P[4]=3285377520;this.ge=this.ec=0};
function Ka(a,b,c){c||(c=0);var d=a.eg;if(q(b))for(var e=0;16>e;e++)d[e]=b.charCodeAt(c)<<24|b.charCodeAt(c+1)<<16|b.charCodeAt(c+2)<<8|b.charCodeAt(c+3),c+=4;else for(e=0;16>e;e++)d[e]=b[c]<<24|b[c+1]<<16|b[c+2]<<8|b[c+3],c+=4;for(e=16;80>e;e++){var f=d[e-3]^d[e-8]^d[e-14]^d[e-16];d[e]=(f<<1|f>>>31)&4294967295}b=a.P[0];c=a.P[1];for(var g=a.P[2],k=a.P[3],m=a.P[4],l,e=0;80>e;e++)40>e?20>e?(f=k^c&(g^k),l=1518500249):(f=c^g^k,l=1859775393):60>e?(f=c&g|k&(c|g),l=2400959708):(f=c^g^k,l=3395469782),f=(b<<
5|b>>>27)+f+m+l+d[e]&4294967295,m=k,k=g,g=(c<<30|c>>>2)&4294967295,c=b,b=f;a.P[0]=a.P[0]+b&4294967295;a.P[1]=a.P[1]+c&4294967295;a.P[2]=a.P[2]+g&4294967295;a.P[3]=a.P[3]+k&4294967295;a.P[4]=a.P[4]+m&4294967295}
Ja.prototype.update=function(a,b){if(null!=a){p(b)||(b=a.length);for(var c=b-this.Ya,d=0,e=this.pe,f=this.ec;d<b;){if(0==f)for(;d<=c;)Ka(this,a,d),d+=this.Ya;if(q(a))for(;d<b;){if(e[f]=a.charCodeAt(d),++f,++d,f==this.Ya){Ka(this,e);f=0;break}}else for(;d<b;)if(e[f]=a[d],++f,++d,f==this.Ya){Ka(this,e);f=0;break}}this.ec=f;this.ge+=b}};var x=Array.prototype,La=x.indexOf?function(a,b,c){return x.indexOf.call(a,b,c)}:function(a,b,c){c=null==c?0:0>c?Math.max(0,a.length+c):c;if(q(a))return q(b)&&1==b.length?a.indexOf(b,c):-1;for(;c<a.length;c++)if(c in a&&a[c]===b)return c;return-1},Ma=x.forEach?function(a,b,c){x.forEach.call(a,b,c)}:function(a,b,c){for(var d=a.length,e=q(a)?a.split(""):a,f=0;f<d;f++)f in e&&b.call(c,e[f],f,a)},Na=x.filter?function(a,b,c){return x.filter.call(a,b,c)}:function(a,b,c){for(var d=a.length,e=[],f=0,g=q(a)?
a.split(""):a,k=0;k<d;k++)if(k in g){var m=g[k];b.call(c,m,k,a)&&(e[f++]=m)}return e},Oa=x.map?function(a,b,c){return x.map.call(a,b,c)}:function(a,b,c){for(var d=a.length,e=Array(d),f=q(a)?a.split(""):a,g=0;g<d;g++)g in f&&(e[g]=b.call(c,f[g],g,a));return e},Pa=x.reduce?function(a,b,c,d){for(var e=[],f=1,g=arguments.length;f<g;f++)e.push(arguments[f]);d&&(e[0]=u(b,d));return x.reduce.apply(a,e)}:function(a,b,c,d){var e=c;Ma(a,function(c,g){e=b.call(d,e,c,g,a)});return e},Qa=x.every?function(a,b,
c){return x.every.call(a,b,c)}:function(a,b,c){for(var d=a.length,e=q(a)?a.split(""):a,f=0;f<d;f++)if(f in e&&!b.call(c,e[f],f,a))return!1;return!0};function Ra(a,b){var c=Sa(a,b,void 0);return 0>c?null:q(a)?a.charAt(c):a[c]}function Sa(a,b,c){for(var d=a.length,e=q(a)?a.split(""):a,f=0;f<d;f++)if(f in e&&b.call(c,e[f],f,a))return f;return-1}function Ta(a,b){var c=La(a,b);0<=c&&x.splice.call(a,c,1)}function Ua(a,b,c){return 2>=arguments.length?x.slice.call(a,b):x.slice.call(a,b,c)}
function Va(a,b){a.sort(b||Wa)}function Wa(a,b){return a>b?1:a<b?-1:0};function Xa(a){n.setTimeout(function(){throw a;},0)}var Ya;
function Za(){var a=n.MessageChannel;"undefined"===typeof a&&"undefined"!==typeof window&&window.postMessage&&window.addEventListener&&-1==w.indexOf("Presto")&&(a=function(){var a=document.createElement("iframe");a.style.display="none";a.src="";document.documentElement.appendChild(a);var b=a.contentWindow,a=b.document;a.open();a.write("");a.close();var c="callImmediate"+Math.random(),d="file:"==b.location.protocol?"*":b.location.protocol+"//"+b.location.host,a=u(function(a){if(("*"==d||a.origin==
d)&&a.data==c)this.port1.onmessage()},this);b.addEventListener("message",a,!1);this.port1={};this.port2={postMessage:function(){b.postMessage(c,d)}}});if("undefined"!==typeof a&&-1==w.indexOf("Trident")&&-1==w.indexOf("MSIE")){var b=new a,c={},d=c;b.port1.onmessage=function(){if(p(c.next)){c=c.next;var a=c.hb;c.hb=null;a()}};return function(a){d.next={hb:a};d=d.next;b.port2.postMessage(0)}}return"undefined"!==typeof document&&"onreadystatechange"in document.createElement("script")?function(a){var b=
document.createElement("script");b.onreadystatechange=function(){b.onreadystatechange=null;b.parentNode.removeChild(b);b=null;a();a=null};document.documentElement.appendChild(b)}:function(a){n.setTimeout(a,0)}};function $a(a,b){ab||bb();cb||(ab(),cb=!0);db.push(new eb(a,b))}var ab;function bb(){if(n.Promise&&n.Promise.resolve){var a=n.Promise.resolve();ab=function(){a.then(fb)}}else ab=function(){var a=fb;!r(n.setImmediate)||n.Window&&n.Window.prototype&&n.Window.prototype.setImmediate==n.setImmediate?(Ya||(Ya=Za()),Ya(a)):n.setImmediate(a)}}var cb=!1,db=[];[].push(function(){cb=!1;db=[]});
function fb(){for(;db.length;){var a=db;db=[];for(var b=0;b<a.length;b++){var c=a[b];try{c.yg.call(c.scope)}catch(d){Xa(d)}}}cb=!1}function eb(a,b){this.yg=a;this.scope=b};var gb=-1!=w.indexOf("Opera")||-1!=w.indexOf("OPR"),hb=-1!=w.indexOf("Trident")||-1!=w.indexOf("MSIE"),ib=-1!=w.indexOf("Gecko")&&-1==w.toLowerCase().indexOf("webkit")&&!(-1!=w.indexOf("Trident")||-1!=w.indexOf("MSIE")),jb=-1!=w.toLowerCase().indexOf("webkit");
(function(){var a="",b;if(gb&&n.opera)return a=n.opera.version,r(a)?a():a;ib?b=/rv\:([^\);]+)(\)|;)/:hb?b=/\b(?:MSIE|rv)[: ]([^\);]+)(\)|;)/:jb&&(b=/WebKit\/(\S+)/);b&&(a=(a=b.exec(w))?a[1]:"");return hb&&(b=(b=n.document)?b.documentMode:void 0,b>parseFloat(a))?String(b):a})();var kb=null,lb=null,mb=null;function nb(a,b){if(!ea(a))throw Error("encodeByteArray takes an array as a parameter");ob();for(var c=b?lb:kb,d=[],e=0;e<a.length;e+=3){var f=a[e],g=e+1<a.length,k=g?a[e+1]:0,m=e+2<a.length,l=m?a[e+2]:0,t=f>>2,f=(f&3)<<4|k>>4,k=(k&15)<<2|l>>6,l=l&63;m||(l=64,g||(k=64));d.push(c[t],c[f],c[k],c[l])}return d.join("")}
function ob(){if(!kb){kb={};lb={};mb={};for(var a=0;65>a;a++)kb[a]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a),lb[a]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.".charAt(a),mb[lb[a]]=a,62<=a&&(mb["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=".charAt(a)]=a)}};function pb(a,b){this.N=qb;this.Rf=void 0;this.Ba=this.Ha=null;this.yd=this.ye=!1;if(a==rb)sb(this,tb,b);else try{var c=this;a.call(b,function(a){sb(c,tb,a)},function(a){if(!(a instanceof ub))try{if(a instanceof Error)throw a;throw Error("Promise rejected.");}catch(b){}sb(c,vb,a)})}catch(d){sb(this,vb,d)}}var qb=0,tb=2,vb=3;function rb(){}pb.prototype.then=function(a,b,c){return wb(this,r(a)?a:null,r(b)?b:null,c)};pb.prototype.then=pb.prototype.then;pb.prototype.$goog_Thenable=!0;h=pb.prototype;
h.gh=function(a,b){return wb(this,null,a,b)};h.cancel=function(a){this.N==qb&&$a(function(){var b=new ub(a);xb(this,b)},this)};function xb(a,b){if(a.N==qb)if(a.Ha){var c=a.Ha;if(c.Ba){for(var d=0,e=-1,f=0,g;g=c.Ba[f];f++)if(g=g.o)if(d++,g==a&&(e=f),0<=e&&1<d)break;0<=e&&(c.N==qb&&1==d?xb(c,b):(d=c.Ba.splice(e,1)[0],yb(c,d,vb,b)))}a.Ha=null}else sb(a,vb,b)}function zb(a,b){a.Ba&&a.Ba.length||a.N!=tb&&a.N!=vb||Ab(a);a.Ba||(a.Ba=[]);a.Ba.push(b)}
function wb(a,b,c,d){var e={o:null,Hf:null,Jf:null};e.o=new pb(function(a,g){e.Hf=b?function(c){try{var e=b.call(d,c);a(e)}catch(l){g(l)}}:a;e.Jf=c?function(b){try{var e=c.call(d,b);!p(e)&&b instanceof ub?g(b):a(e)}catch(l){g(l)}}:g});e.o.Ha=a;zb(a,e);return e.o}h.Yf=function(a){this.N=qb;sb(this,tb,a)};h.Zf=function(a){this.N=qb;sb(this,vb,a)};
function sb(a,b,c){if(a.N==qb){if(a==c)b=vb,c=new TypeError("Promise cannot resolve to itself");else{var d;if(c)try{d=!!c.$goog_Thenable}catch(e){d=!1}else d=!1;if(d){a.N=1;c.then(a.Yf,a.Zf,a);return}if(ga(c))try{var f=c.then;if(r(f)){Bb(a,c,f);return}}catch(g){b=vb,c=g}}a.Rf=c;a.N=b;a.Ha=null;Ab(a);b!=vb||c instanceof ub||Cb(a,c)}}function Bb(a,b,c){function d(b){f||(f=!0,a.Zf(b))}function e(b){f||(f=!0,a.Yf(b))}a.N=1;var f=!1;try{c.call(b,e,d)}catch(g){d(g)}}
function Ab(a){a.ye||(a.ye=!0,$a(a.wg,a))}h.wg=function(){for(;this.Ba&&this.Ba.length;){var a=this.Ba;this.Ba=null;for(var b=0;b<a.length;b++)yb(this,a[b],this.N,this.Rf)}this.ye=!1};function yb(a,b,c,d){if(c==tb)b.Hf(d);else{if(b.o)for(;a&&a.yd;a=a.Ha)a.yd=!1;b.Jf(d)}}function Cb(a,b){a.yd=!0;$a(function(){a.yd&&Db.call(null,b)})}var Db=Xa;function ub(a){la.call(this,a)}ka(ub,la);ub.prototype.name="cancel";var Eb=Eb||"2.4.2";function y(a,b){return Object.prototype.hasOwnProperty.call(a,b)}function z(a,b){if(Object.prototype.hasOwnProperty.call(a,b))return a[b]}function Fb(a,b){for(var c in a)Object.prototype.hasOwnProperty.call(a,c)&&b(c,a[c])}function Gb(a){var b={};Fb(a,function(a,d){b[a]=d});return b}function Hb(a){return"object"===typeof a&&null!==a};function Ib(a){var b=[];Fb(a,function(a,d){da(d)?Ma(d,function(d){b.push(encodeURIComponent(a)+"="+encodeURIComponent(d))}):b.push(encodeURIComponent(a)+"="+encodeURIComponent(d))});return b.length?"&"+b.join("&"):""}function Jb(a){var b={};a=a.replace(/^\?/,"").split("&");Ma(a,function(a){a&&(a=a.split("="),b[a[0]]=a[1])});return b};function Kb(a,b){if(!a)throw Lb(b);}function Lb(a){return Error("Firebase ("+Eb+") INTERNAL ASSERT FAILED: "+a)};var Mb=n.Promise||pb;pb.prototype["catch"]=pb.prototype.gh;function B(){var a=this;this.reject=this.resolve=null;this.D=new Mb(function(b,c){a.resolve=b;a.reject=c})}function C(a,b){return function(c,d){c?a.reject(c):a.resolve(d);r(b)&&(Nb(a.D),1===b.length?b(c):b(c,d))}}function Nb(a){a.then(void 0,aa)};function Ob(a){for(var b=[],c=0,d=0;d<a.length;d++){var e=a.charCodeAt(d);55296<=e&&56319>=e&&(e-=55296,d++,Kb(d<a.length,"Surrogate pair missing trail surrogate."),e=65536+(e<<10)+(a.charCodeAt(d)-56320));128>e?b[c++]=e:(2048>e?b[c++]=e>>6|192:(65536>e?b[c++]=e>>12|224:(b[c++]=e>>18|240,b[c++]=e>>12&63|128),b[c++]=e>>6&63|128),b[c++]=e&63|128)}return b}function Pb(a){for(var b=0,c=0;c<a.length;c++){var d=a.charCodeAt(c);128>d?b++:2048>d?b+=2:55296<=d&&56319>=d?(b+=4,c++):b+=3}return b};function D(a,b,c,d){var e;d<b?e="at least "+b:d>c&&(e=0===c?"none":"no more than "+c);if(e)throw Error(a+" failed: Was called with "+d+(1===d?" argument.":" arguments.")+" Expects "+e+".");}function E(a,b,c){var d="";switch(b){case 1:d=c?"first":"First";break;case 2:d=c?"second":"Second";break;case 3:d=c?"third":"Third";break;case 4:d=c?"fourth":"Fourth";break;default:throw Error("errorPrefix called with argumentNumber > 4.  Need to update it?");}return a=a+" failed: "+(d+" argument ")}
function F(a,b,c,d){if((!d||p(c))&&!r(c))throw Error(E(a,b,d)+"must be a valid function.");}function Qb(a,b,c){if(p(c)&&(!ga(c)||null===c))throw Error(E(a,b,!0)+"must be a valid context object.");};function Rb(a){return"undefined"!==typeof JSON&&p(JSON.parse)?JSON.parse(a):za(a)}function G(a){if("undefined"!==typeof JSON&&p(JSON.stringify))a=JSON.stringify(a);else{var b=[];Ba(new Aa,a,b);a=b.join("")}return a};function Sb(){this.Zd=H}Sb.prototype.j=function(a){return this.Zd.S(a)};Sb.prototype.toString=function(){return this.Zd.toString()};function Tb(){}Tb.prototype.uf=function(){return null};Tb.prototype.Ce=function(){return null};var Ub=new Tb;function Vb(a,b,c){this.bg=a;this.Oa=b;this.Nd=c}Vb.prototype.uf=function(a){var b=this.Oa.Q;if(Wb(b,a))return b.j().T(a);b=null!=this.Nd?new Xb(this.Nd,!0,!1):this.Oa.w();return this.bg.Bc(a,b)};Vb.prototype.Ce=function(a,b,c){var d=null!=this.Nd?this.Nd:Yb(this.Oa);a=this.bg.qe(d,b,1,c,a);return 0===a.length?null:a[0]};function Zb(){this.xb=[]}function $b(a,b){for(var c=null,d=0;d<b.length;d++){var e=b[d],f=e.cc();null===c||f.ea(c.cc())||(a.xb.push(c),c=null);null===c&&(c=new ac(f));c.add(e)}c&&a.xb.push(c)}function bc(a,b,c){$b(a,c);cc(a,function(a){return a.ea(b)})}function dc(a,b,c){$b(a,c);cc(a,function(a){return a.contains(b)||b.contains(a)})}
function cc(a,b){for(var c=!0,d=0;d<a.xb.length;d++){var e=a.xb[d];if(e)if(e=e.cc(),b(e)){for(var e=a.xb[d],f=0;f<e.xd.length;f++){var g=e.xd[f];if(null!==g){e.xd[f]=null;var k=g.Zb();ec&&fc("event: "+g.toString());gc(k)}}a.xb[d]=null}else c=!1}c&&(a.xb=[])}function ac(a){this.ta=a;this.xd=[]}ac.prototype.add=function(a){this.xd.push(a)};ac.prototype.cc=function(){return this.ta};function J(a,b,c,d){this.type=a;this.Na=b;this.Za=c;this.Oe=d;this.Td=void 0}function hc(a){return new J(ic,a)}var ic="value";function jc(a,b,c,d){this.xe=b;this.be=c;this.Td=d;this.wd=a}jc.prototype.cc=function(){var a=this.be.Mb();return"value"===this.wd?a.path:a.parent().path};jc.prototype.De=function(){return this.wd};jc.prototype.Zb=function(){return this.xe.Zb(this)};jc.prototype.toString=function(){return this.cc().toString()+":"+this.wd+":"+G(this.be.qf())};function kc(a,b,c){this.xe=a;this.error=b;this.path=c}kc.prototype.cc=function(){return this.path};kc.prototype.De=function(){return"cancel"};
kc.prototype.Zb=function(){return this.xe.Zb(this)};kc.prototype.toString=function(){return this.path.toString()+":cancel"};function Xb(a,b,c){this.A=a;this.ga=b;this.Yb=c}function lc(a){return a.ga}function mc(a){return a.Yb}function nc(a,b){return b.e()?a.ga&&!a.Yb:Wb(a,K(b))}function Wb(a,b){return a.ga&&!a.Yb||a.A.Fa(b)}Xb.prototype.j=function(){return this.A};function oc(a){this.pg=a;this.Gd=null}oc.prototype.get=function(){var a=this.pg.get(),b=wa(a);if(this.Gd)for(var c in this.Gd)b[c]-=this.Gd[c];this.Gd=a;return b};function pc(a,b){this.Vf={};this.hd=new oc(a);this.da=b;var c=1E4+2E4*Math.random();setTimeout(u(this.Of,this),Math.floor(c))}pc.prototype.Of=function(){var a=this.hd.get(),b={},c=!1,d;for(d in a)0<a[d]&&y(this.Vf,d)&&(b[d]=a[d],c=!0);c&&this.da.Ye(b);setTimeout(u(this.Of,this),Math.floor(6E5*Math.random()))};function qc(){this.Hc={}}function rc(a,b,c){p(c)||(c=1);y(a.Hc,b)||(a.Hc[b]=0);a.Hc[b]+=c}qc.prototype.get=function(){return wa(this.Hc)};var sc={},tc={};function uc(a){a=a.toString();sc[a]||(sc[a]=new qc);return sc[a]}function vc(a,b){var c=a.toString();tc[c]||(tc[c]=b());return tc[c]};function L(a,b){this.name=a;this.U=b}function wc(a,b){return new L(a,b)};function xc(a,b){return yc(a.name,b.name)}function zc(a,b){return yc(a,b)};function Ac(a,b,c){this.type=Bc;this.source=a;this.path=b;this.Ja=c}Ac.prototype.$c=function(a){return this.path.e()?new Ac(this.source,M,this.Ja.T(a)):new Ac(this.source,N(this.path),this.Ja)};Ac.prototype.toString=function(){return"Operation("+this.path+": "+this.source.toString()+" overwrite: "+this.Ja.toString()+")"};function Cc(a,b){this.type=Dc;this.source=a;this.path=b}Cc.prototype.$c=function(){return this.path.e()?new Cc(this.source,M):new Cc(this.source,N(this.path))};Cc.prototype.toString=function(){return"Operation("+this.path+": "+this.source.toString()+" listen_complete)"};function Ec(a,b){this.Pa=a;this.xa=b?b:Fc}h=Ec.prototype;h.Sa=function(a,b){return new Ec(this.Pa,this.xa.Sa(a,b,this.Pa).$(null,null,!1,null,null))};h.remove=function(a){return new Ec(this.Pa,this.xa.remove(a,this.Pa).$(null,null,!1,null,null))};h.get=function(a){for(var b,c=this.xa;!c.e();){b=this.Pa(a,c.key);if(0===b)return c.value;0>b?c=c.left:0<b&&(c=c.right)}return null};
function Gc(a,b){for(var c,d=a.xa,e=null;!d.e();){c=a.Pa(b,d.key);if(0===c){if(d.left.e())return e?e.key:null;for(d=d.left;!d.right.e();)d=d.right;return d.key}0>c?d=d.left:0<c&&(e=d,d=d.right)}throw Error("Attempted to find predecessor key for a nonexistent key.  What gives?");}h.e=function(){return this.xa.e()};h.count=function(){return this.xa.count()};h.Vc=function(){return this.xa.Vc()};h.jc=function(){return this.xa.jc()};h.ka=function(a){return this.xa.ka(a)};
h.ac=function(a){return new Hc(this.xa,null,this.Pa,!1,a)};h.bc=function(a,b){return new Hc(this.xa,a,this.Pa,!1,b)};h.dc=function(a,b){return new Hc(this.xa,a,this.Pa,!0,b)};h.xf=function(a){return new Hc(this.xa,null,this.Pa,!0,a)};function Hc(a,b,c,d,e){this.Xd=e||null;this.Je=d;this.Ta=[];for(e=1;!a.e();)if(e=b?c(a.key,b):1,d&&(e*=-1),0>e)a=this.Je?a.left:a.right;else if(0===e){this.Ta.push(a);break}else this.Ta.push(a),a=this.Je?a.right:a.left}
function Ic(a){if(0===a.Ta.length)return null;var b=a.Ta.pop(),c;c=a.Xd?a.Xd(b.key,b.value):{key:b.key,value:b.value};if(a.Je)for(b=b.left;!b.e();)a.Ta.push(b),b=b.right;else for(b=b.right;!b.e();)a.Ta.push(b),b=b.left;return c}function Jc(a){if(0===a.Ta.length)return null;var b;b=a.Ta;b=b[b.length-1];return a.Xd?a.Xd(b.key,b.value):{key:b.key,value:b.value}}function Kc(a,b,c,d,e){this.key=a;this.value=b;this.color=null!=c?c:!0;this.left=null!=d?d:Fc;this.right=null!=e?e:Fc}h=Kc.prototype;
h.$=function(a,b,c,d,e){return new Kc(null!=a?a:this.key,null!=b?b:this.value,null!=c?c:this.color,null!=d?d:this.left,null!=e?e:this.right)};h.count=function(){return this.left.count()+1+this.right.count()};h.e=function(){return!1};h.ka=function(a){return this.left.ka(a)||a(this.key,this.value)||this.right.ka(a)};function Lc(a){return a.left.e()?a:Lc(a.left)}h.Vc=function(){return Lc(this).key};h.jc=function(){return this.right.e()?this.key:this.right.jc()};
h.Sa=function(a,b,c){var d,e;e=this;d=c(a,e.key);e=0>d?e.$(null,null,null,e.left.Sa(a,b,c),null):0===d?e.$(null,b,null,null,null):e.$(null,null,null,null,e.right.Sa(a,b,c));return Mc(e)};function Nc(a){if(a.left.e())return Fc;a.left.ha()||a.left.left.ha()||(a=Oc(a));a=a.$(null,null,null,Nc(a.left),null);return Mc(a)}
h.remove=function(a,b){var c,d;c=this;if(0>b(a,c.key))c.left.e()||c.left.ha()||c.left.left.ha()||(c=Oc(c)),c=c.$(null,null,null,c.left.remove(a,b),null);else{c.left.ha()&&(c=Pc(c));c.right.e()||c.right.ha()||c.right.left.ha()||(c=Qc(c),c.left.left.ha()&&(c=Pc(c),c=Qc(c)));if(0===b(a,c.key)){if(c.right.e())return Fc;d=Lc(c.right);c=c.$(d.key,d.value,null,null,Nc(c.right))}c=c.$(null,null,null,null,c.right.remove(a,b))}return Mc(c)};h.ha=function(){return this.color};
function Mc(a){a.right.ha()&&!a.left.ha()&&(a=Rc(a));a.left.ha()&&a.left.left.ha()&&(a=Pc(a));a.left.ha()&&a.right.ha()&&(a=Qc(a));return a}function Oc(a){a=Qc(a);a.right.left.ha()&&(a=a.$(null,null,null,null,Pc(a.right)),a=Rc(a),a=Qc(a));return a}function Rc(a){return a.right.$(null,null,a.color,a.$(null,null,!0,null,a.right.left),null)}function Pc(a){return a.left.$(null,null,a.color,null,a.$(null,null,!0,a.left.right,null))}
function Qc(a){return a.$(null,null,!a.color,a.left.$(null,null,!a.left.color,null,null),a.right.$(null,null,!a.right.color,null,null))}function Sc(){}h=Sc.prototype;h.$=function(){return this};h.Sa=function(a,b){return new Kc(a,b,null)};h.remove=function(){return this};h.count=function(){return 0};h.e=function(){return!0};h.ka=function(){return!1};h.Vc=function(){return null};h.jc=function(){return null};h.ha=function(){return!1};var Fc=new Sc;function Tc(a,b){return a&&"object"===typeof a?(O(".sv"in a,"Unexpected leaf node or priority contents"),b[a[".sv"]]):a}function Uc(a,b){var c=new Vc;Wc(a,new P(""),function(a,e){c.rc(a,Xc(e,b))});return c}function Xc(a,b){var c=a.C().J(),c=Tc(c,b),d;if(a.L()){var e=Tc(a.Ea(),b);return e!==a.Ea()||c!==a.C().J()?new Yc(e,Q(c)):a}d=a;c!==a.C().J()&&(d=d.ia(new Yc(c)));a.R(R,function(a,c){var e=Xc(c,b);e!==c&&(d=d.W(a,e))});return d};function Zc(){this.Ac={}}Zc.prototype.set=function(a,b){null==b?delete this.Ac[a]:this.Ac[a]=b};Zc.prototype.get=function(a){return y(this.Ac,a)?this.Ac[a]:null};Zc.prototype.remove=function(a){delete this.Ac[a]};Zc.prototype.Af=!0;function $c(a){this.Ic=a;this.Sd="firebase:"}h=$c.prototype;h.set=function(a,b){null==b?this.Ic.removeItem(this.Sd+a):this.Ic.setItem(this.Sd+a,G(b))};h.get=function(a){a=this.Ic.getItem(this.Sd+a);return null==a?null:Rb(a)};h.remove=function(a){this.Ic.removeItem(this.Sd+a)};h.Af=!1;h.toString=function(){return this.Ic.toString()};function ad(a){try{if("undefined"!==typeof window&&"undefined"!==typeof window[a]){var b=window[a];b.setItem("firebase:sentinel","cache");b.removeItem("firebase:sentinel");return new $c(b)}}catch(c){}return new Zc}var bd=ad("localStorage"),cd=ad("sessionStorage");function dd(a,b,c,d,e){this.host=a.toLowerCase();this.domain=this.host.substr(this.host.indexOf(".")+1);this.ob=b;this.lc=c;this.jh=d;this.Rd=e||"";this.ab=bd.get("host:"+a)||this.host}function ed(a,b){b!==a.ab&&(a.ab=b,"s-"===a.ab.substr(0,2)&&bd.set("host:"+a.host,a.ab))}
function fd(a,b,c){O("string"===typeof b,"typeof type must == string");O("object"===typeof c,"typeof params must == object");if(b===gd)b=(a.ob?"wss://":"ws://")+a.ab+"/.ws?";else if(b===hd)b=(a.ob?"https://":"http://")+a.ab+"/.lp?";else throw Error("Unknown connection type: "+b);a.host!==a.ab&&(c.ns=a.lc);var d=[];v(c,function(a,b){d.push(b+"="+a)});return b+d.join("&")}dd.prototype.toString=function(){var a=(this.ob?"https://":"http://")+this.host;this.Rd&&(a+="<"+this.Rd+">");return a};var id=function(){var a=1;return function(){return a++}}(),O=Kb,jd=Lb;
function kd(a){try{var b;if("undefined"!==typeof atob)b=atob(a);else{ob();for(var c=mb,d=[],e=0;e<a.length;){var f=c[a.charAt(e++)],g=e<a.length?c[a.charAt(e)]:0;++e;var k=e<a.length?c[a.charAt(e)]:64;++e;var m=e<a.length?c[a.charAt(e)]:64;++e;if(null==f||null==g||null==k||null==m)throw Error();d.push(f<<2|g>>4);64!=k&&(d.push(g<<4&240|k>>2),64!=m&&d.push(k<<6&192|m))}if(8192>d.length)b=String.fromCharCode.apply(null,d);else{a="";for(c=0;c<d.length;c+=8192)a+=String.fromCharCode.apply(null,Ua(d,c,
c+8192));b=a}}return b}catch(l){fc("base64Decode failed: ",l)}return null}function ld(a){var b=Ob(a);a=new Ja;a.update(b);var b=[],c=8*a.ge;56>a.ec?a.update(a.Od,56-a.ec):a.update(a.Od,a.Ya-(a.ec-56));for(var d=a.Ya-1;56<=d;d--)a.pe[d]=c&255,c/=256;Ka(a,a.pe);for(d=c=0;5>d;d++)for(var e=24;0<=e;e-=8)b[c]=a.P[d]>>e&255,++c;return nb(b)}
function md(a){for(var b="",c=0;c<arguments.length;c++)b=ea(arguments[c])?b+md.apply(null,arguments[c]):"object"===typeof arguments[c]?b+G(arguments[c]):b+arguments[c],b+=" ";return b}var ec=null,nd=!0;
function od(a,b){Kb(!b||!0===a||!1===a,"Can't turn on custom loggers persistently.");!0===a?("undefined"!==typeof console&&("function"===typeof console.log?ec=u(console.log,console):"object"===typeof console.log&&(ec=function(a){console.log(a)})),b&&cd.set("logging_enabled",!0)):r(a)?ec=a:(ec=null,cd.remove("logging_enabled"))}function fc(a){!0===nd&&(nd=!1,null===ec&&!0===cd.get("logging_enabled")&&od(!0));if(ec){var b=md.apply(null,arguments);ec(b)}}
function pd(a){return function(){fc(a,arguments)}}function qd(a){if("undefined"!==typeof console){var b="FIREBASE INTERNAL ERROR: "+md.apply(null,arguments);"undefined"!==typeof console.error?console.error(b):console.log(b)}}function rd(a){var b=md.apply(null,arguments);throw Error("FIREBASE FATAL ERROR: "+b);}function S(a){if("undefined"!==typeof console){var b="FIREBASE WARNING: "+md.apply(null,arguments);"undefined"!==typeof console.warn?console.warn(b):console.log(b)}}
function sd(a){var b="",c="",d="",e="",f=!0,g="https",k=443;if(q(a)){var m=a.indexOf("//");0<=m&&(g=a.substring(0,m-1),a=a.substring(m+2));m=a.indexOf("/");-1===m&&(m=a.length);b=a.substring(0,m);e="";a=a.substring(m).split("/");for(m=0;m<a.length;m++)if(0<a[m].length){var l=a[m];try{l=decodeURIComponent(l.replace(/\+/g," "))}catch(t){}e+="/"+l}a=b.split(".");3===a.length?(c=a[1],d=a[0].toLowerCase()):2===a.length&&(c=a[0]);m=b.indexOf(":");0<=m&&(f="https"===g||"wss"===g,k=b.substring(m+1),isFinite(k)&&
(k=String(k)),k=q(k)?/^\s*-?0x/i.test(k)?parseInt(k,16):parseInt(k,10):NaN)}return{host:b,port:k,domain:c,fh:d,ob:f,scheme:g,bd:e}}function td(a){return fa(a)&&(a!=a||a==Number.POSITIVE_INFINITY||a==Number.NEGATIVE_INFINITY)}
function ud(a){if("complete"===document.readyState)a();else{var b=!1,c=function(){document.body?b||(b=!0,a()):setTimeout(c,Math.floor(10))};document.addEventListener?(document.addEventListener("DOMContentLoaded",c,!1),window.addEventListener("load",c,!1)):document.attachEvent&&(document.attachEvent("onreadystatechange",function(){"complete"===document.readyState&&c()}),window.attachEvent("onload",c))}}
function yc(a,b){if(a===b)return 0;if("[MIN_NAME]"===a||"[MAX_NAME]"===b)return-1;if("[MIN_NAME]"===b||"[MAX_NAME]"===a)return 1;var c=vd(a),d=vd(b);return null!==c?null!==d?0==c-d?a.length-b.length:c-d:-1:null!==d?1:a<b?-1:1}function wd(a,b){if(b&&a in b)return b[a];throw Error("Missing required key ("+a+") in object: "+G(b));}
function xd(a){if("object"!==typeof a||null===a)return G(a);var b=[],c;for(c in a)b.push(c);b.sort();c="{";for(var d=0;d<b.length;d++)0!==d&&(c+=","),c+=G(b[d]),c+=":",c+=xd(a[b[d]]);return c+"}"}function yd(a,b){if(a.length<=b)return[a];for(var c=[],d=0;d<a.length;d+=b)d+b>a?c.push(a.substring(d,a.length)):c.push(a.substring(d,d+b));return c}function zd(a,b){if(da(a))for(var c=0;c<a.length;++c)b(c,a[c]);else v(a,b)}
function Ad(a){O(!td(a),"Invalid JSON number");var b,c,d,e;0===a?(d=c=0,b=-Infinity===1/a?1:0):(b=0>a,a=Math.abs(a),a>=Math.pow(2,-1022)?(d=Math.min(Math.floor(Math.log(a)/Math.LN2),1023),c=d+1023,d=Math.round(a*Math.pow(2,52-d)-Math.pow(2,52))):(c=0,d=Math.round(a/Math.pow(2,-1074))));e=[];for(a=52;a;--a)e.push(d%2?1:0),d=Math.floor(d/2);for(a=11;a;--a)e.push(c%2?1:0),c=Math.floor(c/2);e.push(b?1:0);e.reverse();b=e.join("");c="";for(a=0;64>a;a+=8)d=parseInt(b.substr(a,8),2).toString(16),1===d.length&&
(d="0"+d),c+=d;return c.toLowerCase()}var Bd=/^-?\d{1,10}$/;function vd(a){return Bd.test(a)&&(a=Number(a),-2147483648<=a&&2147483647>=a)?a:null}function gc(a){try{a()}catch(b){setTimeout(function(){S("Exception was thrown by user callback.",b.stack||"");throw b;},Math.floor(0))}}function T(a,b){if(r(a)){var c=Array.prototype.slice.call(arguments,1).slice();gc(function(){a.apply(null,c)})}};function Cd(a){var b={},c={},d={},e="";try{var f=a.split("."),b=Rb(kd(f[0])||""),c=Rb(kd(f[1])||""),e=f[2],d=c.d||{};delete c.d}catch(g){}return{mh:b,Ec:c,data:d,bh:e}}function Dd(a){a=Cd(a).Ec;return"object"===typeof a&&a.hasOwnProperty("iat")?z(a,"iat"):null}function Ed(a){a=Cd(a);var b=a.Ec;return!!a.bh&&!!b&&"object"===typeof b&&b.hasOwnProperty("iat")};function Fd(a){this.Y=a;this.g=a.n.g}function Gd(a,b,c,d){var e=[],f=[];Ma(b,function(b){"child_changed"===b.type&&a.g.Dd(b.Oe,b.Na)&&f.push(new J("child_moved",b.Na,b.Za))});Hd(a,e,"child_removed",b,d,c);Hd(a,e,"child_added",b,d,c);Hd(a,e,"child_moved",f,d,c);Hd(a,e,"child_changed",b,d,c);Hd(a,e,ic,b,d,c);return e}function Hd(a,b,c,d,e,f){d=Na(d,function(a){return a.type===c});Va(d,u(a.qg,a));Ma(d,function(c){var d=Id(a,c,f);Ma(e,function(e){e.Qf(c.type)&&b.push(e.createEvent(d,a.Y))})})}
function Id(a,b,c){"value"!==b.type&&"child_removed"!==b.type&&(b.Td=c.wf(b.Za,b.Na,a.g));return b}Fd.prototype.qg=function(a,b){if(null==a.Za||null==b.Za)throw jd("Should only compare child_ events.");return this.g.compare(new L(a.Za,a.Na),new L(b.Za,b.Na))};function Jd(){this.ib={}}
function Kd(a,b){var c=b.type,d=b.Za;O("child_added"==c||"child_changed"==c||"child_removed"==c,"Only child changes supported for tracking");O(".priority"!==d,"Only non-priority child changes can be tracked.");var e=z(a.ib,d);if(e){var f=e.type;if("child_added"==c&&"child_removed"==f)a.ib[d]=new J("child_changed",b.Na,d,e.Na);else if("child_removed"==c&&"child_added"==f)delete a.ib[d];else if("child_removed"==c&&"child_changed"==f)a.ib[d]=new J("child_removed",e.Oe,d);else if("child_changed"==c&&
"child_added"==f)a.ib[d]=new J("child_added",b.Na,d);else if("child_changed"==c&&"child_changed"==f)a.ib[d]=new J("child_changed",b.Na,d,e.Oe);else throw jd("Illegal combination of changes: "+b+" occurred after "+e);}else a.ib[d]=b};function Ld(a){this.g=a}h=Ld.prototype;h.H=function(a,b,c,d,e,f){O(a.Mc(this.g),"A node must be indexed if only a child is updated");e=a.T(b);if(e.S(d).ea(c.S(d))&&e.e()==c.e())return a;null!=f&&(c.e()?a.Fa(b)?Kd(f,new J("child_removed",e,b)):O(a.L(),"A child remove without an old child only makes sense on a leaf node"):e.e()?Kd(f,new J("child_added",c,b)):Kd(f,new J("child_changed",c,b,e)));return a.L()&&c.e()?a:a.W(b,c).pb(this.g)};
h.ya=function(a,b,c){null!=c&&(a.L()||a.R(R,function(a,e){b.Fa(a)||Kd(c,new J("child_removed",e,a))}),b.L()||b.R(R,function(b,e){if(a.Fa(b)){var f=a.T(b);f.ea(e)||Kd(c,new J("child_changed",e,b,f))}else Kd(c,new J("child_added",e,b))}));return b.pb(this.g)};h.ia=function(a,b){return a.e()?H:a.ia(b)};h.Ra=function(){return!1};h.$b=function(){return this};function Md(a){this.Fe=new Ld(a.g);this.g=a.g;var b;a.oa?(b=Nd(a),b=a.g.Sc(Od(a),b)):b=a.g.Wc();this.gd=b;a.ra?(b=Pd(a),a=a.g.Sc(Rd(a),b)):a=a.g.Tc();this.Jc=a}h=Md.prototype;h.matches=function(a){return 0>=this.g.compare(this.gd,a)&&0>=this.g.compare(a,this.Jc)};h.H=function(a,b,c,d,e,f){this.matches(new L(b,c))||(c=H);return this.Fe.H(a,b,c,d,e,f)};
h.ya=function(a,b,c){b.L()&&(b=H);var d=b.pb(this.g),d=d.ia(H),e=this;b.R(R,function(a,b){e.matches(new L(a,b))||(d=d.W(a,H))});return this.Fe.ya(a,d,c)};h.ia=function(a){return a};h.Ra=function(){return!0};h.$b=function(){return this.Fe};function Sd(a){this.ua=new Md(a);this.g=a.g;O(a.la,"Only valid if limit has been set");this.ma=a.ma;this.Nb=!Td(a)}h=Sd.prototype;h.H=function(a,b,c,d,e,f){this.ua.matches(new L(b,c))||(c=H);return a.T(b).ea(c)?a:a.Hb()<this.ma?this.ua.$b().H(a,b,c,d,e,f):Ud(this,a,b,c,e,f)};
h.ya=function(a,b,c){var d;if(b.L()||b.e())d=H.pb(this.g);else if(2*this.ma<b.Hb()&&b.Mc(this.g)){d=H.pb(this.g);b=this.Nb?b.dc(this.ua.Jc,this.g):b.bc(this.ua.gd,this.g);for(var e=0;0<b.Ta.length&&e<this.ma;){var f=Ic(b),g;if(g=this.Nb?0>=this.g.compare(this.ua.gd,f):0>=this.g.compare(f,this.ua.Jc))d=d.W(f.name,f.U),e++;else break}}else{d=b.pb(this.g);d=d.ia(H);var k,m,l;if(this.Nb){b=d.xf(this.g);k=this.ua.Jc;m=this.ua.gd;var t=Vd(this.g);l=function(a,b){return t(b,a)}}else b=d.ac(this.g),k=this.ua.gd,
m=this.ua.Jc,l=Vd(this.g);for(var e=0,A=!1;0<b.Ta.length;)f=Ic(b),!A&&0>=l(k,f)&&(A=!0),(g=A&&e<this.ma&&0>=l(f,m))?e++:d=d.W(f.name,H)}return this.ua.$b().ya(a,d,c)};h.ia=function(a){return a};h.Ra=function(){return!0};h.$b=function(){return this.ua.$b()};
function Ud(a,b,c,d,e,f){var g;if(a.Nb){var k=Vd(a.g);g=function(a,b){return k(b,a)}}else g=Vd(a.g);O(b.Hb()==a.ma,"");var m=new L(c,d),l=a.Nb?Wd(b,a.g):Xd(b,a.g),t=a.ua.matches(m);if(b.Fa(c)){for(var A=b.T(c),l=e.Ce(a.g,l,a.Nb);null!=l&&(l.name==c||b.Fa(l.name));)l=e.Ce(a.g,l,a.Nb);e=null==l?1:g(l,m);if(t&&!d.e()&&0<=e)return null!=f&&Kd(f,new J("child_changed",d,c,A)),b.W(c,d);null!=f&&Kd(f,new J("child_removed",A,c));b=b.W(c,H);return null!=l&&a.ua.matches(l)?(null!=f&&Kd(f,new J("child_added",
l.U,l.name)),b.W(l.name,l.U)):b}return d.e()?b:t&&0<=g(l,m)?(null!=f&&(Kd(f,new J("child_removed",l.U,l.name)),Kd(f,new J("child_added",d,c))),b.W(c,d).W(l.name,H)):b};function Yd(a,b){this.me=a;this.og=b}function Zd(a){this.X=a}
Zd.prototype.gb=function(a,b,c,d){var e=new Jd,f;if(b.type===Bc)b.source.Ae?c=$d(this,a,b.path,b.Ja,c,d,e):(O(b.source.tf,"Unknown source."),f=b.source.ef||mc(a.w())&&!b.path.e(),c=ae(this,a,b.path,b.Ja,c,d,f,e));else if(b.type===be)b.source.Ae?c=ce(this,a,b.path,b.children,c,d,e):(O(b.source.tf,"Unknown source."),f=b.source.ef||mc(a.w()),c=de(this,a,b.path,b.children,c,d,f,e));else if(b.type===ee)if(b.Yd)if(b=b.path,null!=c.xc(b))c=a;else{f=new Vb(c,a,d);d=a.Q.j();if(b.e()||".priority"===K(b))lc(a.w())?
b=c.Aa(Yb(a)):(b=a.w().j(),O(b instanceof fe,"serverChildren would be complete if leaf node"),b=c.Cc(b)),b=this.X.ya(d,b,e);else{var g=K(b),k=c.Bc(g,a.w());null==k&&Wb(a.w(),g)&&(k=d.T(g));b=null!=k?this.X.H(d,g,k,N(b),f,e):a.Q.j().Fa(g)?this.X.H(d,g,H,N(b),f,e):d;b.e()&&lc(a.w())&&(d=c.Aa(Yb(a)),d.L()&&(b=this.X.ya(b,d,e)))}d=lc(a.w())||null!=c.xc(M);c=ge(a,b,d,this.X.Ra())}else c=he(this,a,b.path,b.Ub,c,d,e);else if(b.type===Dc)d=b.path,b=a.w(),f=b.j(),g=b.ga||d.e(),c=ie(this,new je(a.Q,new Xb(f,
g,b.Yb)),d,c,Ub,e);else throw jd("Unknown operation type: "+b.type);e=qa(e.ib);d=c;b=d.Q;b.ga&&(f=b.j().L()||b.j().e(),g=ke(a),(0<e.length||!a.Q.ga||f&&!b.j().ea(g)||!b.j().C().ea(g.C()))&&e.push(hc(ke(d))));return new Yd(c,e)};
function ie(a,b,c,d,e,f){var g=b.Q;if(null!=d.xc(c))return b;var k;if(c.e())O(lc(b.w()),"If change path is empty, we must have complete server data"),mc(b.w())?(e=Yb(b),d=d.Cc(e instanceof fe?e:H)):d=d.Aa(Yb(b)),f=a.X.ya(b.Q.j(),d,f);else{var m=K(c);if(".priority"==m)O(1==le(c),"Can't have a priority with additional path components"),f=g.j(),k=b.w().j(),d=d.nd(c,f,k),f=null!=d?a.X.ia(f,d):g.j();else{var l=N(c);Wb(g,m)?(k=b.w().j(),d=d.nd(c,g.j(),k),d=null!=d?g.j().T(m).H(l,d):g.j().T(m)):d=d.Bc(m,
b.w());f=null!=d?a.X.H(g.j(),m,d,l,e,f):g.j()}}return ge(b,f,g.ga||c.e(),a.X.Ra())}function ae(a,b,c,d,e,f,g,k){var m=b.w();g=g?a.X:a.X.$b();if(c.e())d=g.ya(m.j(),d,null);else if(g.Ra()&&!m.Yb)d=m.j().H(c,d),d=g.ya(m.j(),d,null);else{var l=K(c);if(!nc(m,c)&&1<le(c))return b;var t=N(c);d=m.j().T(l).H(t,d);d=".priority"==l?g.ia(m.j(),d):g.H(m.j(),l,d,t,Ub,null)}m=m.ga||c.e();b=new je(b.Q,new Xb(d,m,g.Ra()));return ie(a,b,c,e,new Vb(e,b,f),k)}
function $d(a,b,c,d,e,f,g){var k=b.Q;e=new Vb(e,b,f);if(c.e())g=a.X.ya(b.Q.j(),d,g),a=ge(b,g,!0,a.X.Ra());else if(f=K(c),".priority"===f)g=a.X.ia(b.Q.j(),d),a=ge(b,g,k.ga,k.Yb);else{c=N(c);var m=k.j().T(f);if(!c.e()){var l=e.uf(f);d=null!=l?".priority"===me(c)&&l.S(c.parent()).e()?l:l.H(c,d):H}m.ea(d)?a=b:(g=a.X.H(k.j(),f,d,c,e,g),a=ge(b,g,k.ga,a.X.Ra()))}return a}
function ce(a,b,c,d,e,f,g){var k=b;ne(d,function(d,l){var t=c.o(d);Wb(b.Q,K(t))&&(k=$d(a,k,t,l,e,f,g))});ne(d,function(d,l){var t=c.o(d);Wb(b.Q,K(t))||(k=$d(a,k,t,l,e,f,g))});return k}function oe(a,b){ne(b,function(b,d){a=a.H(b,d)});return a}
function de(a,b,c,d,e,f,g,k){if(b.w().j().e()&&!lc(b.w()))return b;var m=b;c=c.e()?d:pe(qe,c,d);var l=b.w().j();c.children.ka(function(c,d){if(l.Fa(c)){var I=b.w().j().T(c),I=oe(I,d);m=ae(a,m,new P(c),I,e,f,g,k)}});c.children.ka(function(c,d){var I=!Wb(b.w(),c)&&null==d.value;l.Fa(c)||I||(I=b.w().j().T(c),I=oe(I,d),m=ae(a,m,new P(c),I,e,f,g,k))});return m}
function he(a,b,c,d,e,f,g){if(null!=e.xc(c))return b;var k=mc(b.w()),m=b.w();if(null!=d.value){if(c.e()&&m.ga||nc(m,c))return ae(a,b,c,m.j().S(c),e,f,k,g);if(c.e()){var l=qe;m.j().R(re,function(a,b){l=l.set(new P(a),b)});return de(a,b,c,l,e,f,k,g)}return b}l=qe;ne(d,function(a){var b=c.o(a);nc(m,b)&&(l=l.set(a,m.j().S(b)))});return de(a,b,c,l,e,f,k,g)};function se(){}var te={};function Vd(a){return u(a.compare,a)}se.prototype.Dd=function(a,b){return 0!==this.compare(new L("[MIN_NAME]",a),new L("[MIN_NAME]",b))};se.prototype.Wc=function(){return ue};function ve(a){O(!a.e()&&".priority"!==K(a),"Can't create PathIndex with empty path or .priority key");this.gc=a}ka(ve,se);h=ve.prototype;h.Lc=function(a){return!a.S(this.gc).e()};h.compare=function(a,b){var c=a.U.S(this.gc),d=b.U.S(this.gc),c=c.Gc(d);return 0===c?yc(a.name,b.name):c};
h.Sc=function(a,b){var c=Q(a),c=H.H(this.gc,c);return new L(b,c)};h.Tc=function(){var a=H.H(this.gc,we);return new L("[MAX_NAME]",a)};h.toString=function(){return this.gc.slice().join("/")};function xe(){}ka(xe,se);h=xe.prototype;h.compare=function(a,b){var c=a.U.C(),d=b.U.C(),c=c.Gc(d);return 0===c?yc(a.name,b.name):c};h.Lc=function(a){return!a.C().e()};h.Dd=function(a,b){return!a.C().ea(b.C())};h.Wc=function(){return ue};h.Tc=function(){return new L("[MAX_NAME]",new Yc("[PRIORITY-POST]",we))};
h.Sc=function(a,b){var c=Q(a);return new L(b,new Yc("[PRIORITY-POST]",c))};h.toString=function(){return".priority"};var R=new xe;function ye(){}ka(ye,se);h=ye.prototype;h.compare=function(a,b){return yc(a.name,b.name)};h.Lc=function(){throw jd("KeyIndex.isDefinedOn not expected to be called.");};h.Dd=function(){return!1};h.Wc=function(){return ue};h.Tc=function(){return new L("[MAX_NAME]",H)};h.Sc=function(a){O(q(a),"KeyIndex indexValue must always be a string.");return new L(a,H)};h.toString=function(){return".key"};
var re=new ye;function ze(){}ka(ze,se);h=ze.prototype;h.compare=function(a,b){var c=a.U.Gc(b.U);return 0===c?yc(a.name,b.name):c};h.Lc=function(){return!0};h.Dd=function(a,b){return!a.ea(b)};h.Wc=function(){return ue};h.Tc=function(){return Ae};h.Sc=function(a,b){var c=Q(a);return new L(b,c)};h.toString=function(){return".value"};var Be=new ze;function Ce(){this.Xb=this.ra=this.Pb=this.oa=this.la=!1;this.ma=0;this.Rb="";this.ic=null;this.Bb="";this.fc=null;this.zb="";this.g=R}var De=new Ce;function Td(a){return""===a.Rb?a.oa:"l"===a.Rb}function Od(a){O(a.oa,"Only valid if start has been set");return a.ic}function Nd(a){O(a.oa,"Only valid if start has been set");return a.Pb?a.Bb:"[MIN_NAME]"}function Rd(a){O(a.ra,"Only valid if end has been set");return a.fc}
function Pd(a){O(a.ra,"Only valid if end has been set");return a.Xb?a.zb:"[MAX_NAME]"}function Ee(a){var b=new Ce;b.la=a.la;b.ma=a.ma;b.oa=a.oa;b.ic=a.ic;b.Pb=a.Pb;b.Bb=a.Bb;b.ra=a.ra;b.fc=a.fc;b.Xb=a.Xb;b.zb=a.zb;b.g=a.g;return b}h=Ce.prototype;h.Le=function(a){var b=Ee(this);b.la=!0;b.ma=a;b.Rb="";return b};h.Me=function(a){var b=Ee(this);b.la=!0;b.ma=a;b.Rb="l";return b};h.Ne=function(a){var b=Ee(this);b.la=!0;b.ma=a;b.Rb="r";return b};
h.ce=function(a,b){var c=Ee(this);c.oa=!0;p(a)||(a=null);c.ic=a;null!=b?(c.Pb=!0,c.Bb=b):(c.Pb=!1,c.Bb="");return c};h.vd=function(a,b){var c=Ee(this);c.ra=!0;p(a)||(a=null);c.fc=a;p(b)?(c.Xb=!0,c.zb=b):(c.oh=!1,c.zb="");return c};function Fe(a,b){var c=Ee(a);c.g=b;return c}function Ge(a){var b={};a.oa&&(b.sp=a.ic,a.Pb&&(b.sn=a.Bb));a.ra&&(b.ep=a.fc,a.Xb&&(b.en=a.zb));if(a.la){b.l=a.ma;var c=a.Rb;""===c&&(c=Td(a)?"l":"r");b.vf=c}a.g!==R&&(b.i=a.g.toString());return b}
function He(a){return!(a.oa||a.ra||a.la)}function Ie(a){return He(a)&&a.g==R}function Je(a){var b={};if(Ie(a))return b;var c;a.g===R?c="$priority":a.g===Be?c="$value":a.g===re?c="$key":(O(a.g instanceof ve,"Unrecognized index type!"),c=a.g.toString());b.orderBy=G(c);a.oa&&(b.startAt=G(a.ic),a.Pb&&(b.startAt+=","+G(a.Bb)));a.ra&&(b.endAt=G(a.fc),a.Xb&&(b.endAt+=","+G(a.zb)));a.la&&(Td(a)?b.limitToFirst=a.ma:b.limitToLast=a.ma);return b}h.toString=function(){return G(Ge(this))};function Ke(a,b){this.Ed=a;this.hc=b}Ke.prototype.get=function(a){var b=z(this.Ed,a);if(!b)throw Error("No index defined for "+a);return b===te?null:b};function Le(a,b,c){var d=ma(a.Ed,function(d,f){var g=z(a.hc,f);O(g,"Missing index implementation for "+f);if(d===te){if(g.Lc(b.U)){for(var k=[],m=c.ac(wc),l=Ic(m);l;)l.name!=b.name&&k.push(l),l=Ic(m);k.push(b);return Me(k,Vd(g))}return te}g=c.get(b.name);k=d;g&&(k=k.remove(new L(b.name,g)));return k.Sa(b,b.U)});return new Ke(d,a.hc)}
function Ne(a,b,c){var d=ma(a.Ed,function(a){if(a===te)return a;var d=c.get(b.name);return d?a.remove(new L(b.name,d)):a});return new Ke(d,a.hc)}var Oe=new Ke({".priority":te},{".priority":R});function Yc(a,b){this.B=a;O(p(this.B)&&null!==this.B,"LeafNode shouldn't be created with null/undefined value.");this.ca=b||H;Pe(this.ca);this.Gb=null}var Qe=["object","boolean","number","string"];h=Yc.prototype;h.L=function(){return!0};h.C=function(){return this.ca};h.ia=function(a){return new Yc(this.B,a)};h.T=function(a){return".priority"===a?this.ca:H};h.S=function(a){return a.e()?this:".priority"===K(a)?this.ca:H};h.Fa=function(){return!1};h.wf=function(){return null};
h.W=function(a,b){return".priority"===a?this.ia(b):b.e()&&".priority"!==a?this:H.W(a,b).ia(this.ca)};h.H=function(a,b){var c=K(a);if(null===c)return b;if(b.e()&&".priority"!==c)return this;O(".priority"!==c||1===le(a),".priority must be the last token in a path");return this.W(c,H.H(N(a),b))};h.e=function(){return!1};h.Hb=function(){return 0};h.R=function(){return!1};h.J=function(a){return a&&!this.C().e()?{".value":this.Ea(),".priority":this.C().J()}:this.Ea()};
h.hash=function(){if(null===this.Gb){var a="";this.ca.e()||(a+="priority:"+Re(this.ca.J())+":");var b=typeof this.B,a=a+(b+":"),a="number"===b?a+Ad(this.B):a+this.B;this.Gb=ld(a)}return this.Gb};h.Ea=function(){return this.B};h.Gc=function(a){if(a===H)return 1;if(a instanceof fe)return-1;O(a.L(),"Unknown node type");var b=typeof a.B,c=typeof this.B,d=La(Qe,b),e=La(Qe,c);O(0<=d,"Unknown leaf type: "+b);O(0<=e,"Unknown leaf type: "+c);return d===e?"object"===c?0:this.B<a.B?-1:this.B===a.B?0:1:e-d};
h.pb=function(){return this};h.Mc=function(){return!0};h.ea=function(a){return a===this?!0:a.L()?this.B===a.B&&this.ca.ea(a.ca):!1};h.toString=function(){return G(this.J(!0))};function fe(a,b,c){this.m=a;(this.ca=b)&&Pe(this.ca);a.e()&&O(!this.ca||this.ca.e(),"An empty node cannot have a priority");this.Ab=c;this.Gb=null}h=fe.prototype;h.L=function(){return!1};h.C=function(){return this.ca||H};h.ia=function(a){return this.m.e()?this:new fe(this.m,a,this.Ab)};h.T=function(a){if(".priority"===a)return this.C();a=this.m.get(a);return null===a?H:a};h.S=function(a){var b=K(a);return null===b?this:this.T(b).S(N(a))};h.Fa=function(a){return null!==this.m.get(a)};
h.W=function(a,b){O(b,"We should always be passing snapshot nodes");if(".priority"===a)return this.ia(b);var c=new L(a,b),d,e;b.e()?(d=this.m.remove(a),c=Ne(this.Ab,c,this.m)):(d=this.m.Sa(a,b),c=Le(this.Ab,c,this.m));e=d.e()?H:this.ca;return new fe(d,e,c)};h.H=function(a,b){var c=K(a);if(null===c)return b;O(".priority"!==K(a)||1===le(a),".priority must be the last token in a path");var d=this.T(c).H(N(a),b);return this.W(c,d)};h.e=function(){return this.m.e()};h.Hb=function(){return this.m.count()};
var Se=/^(0|[1-9]\d*)$/;h=fe.prototype;h.J=function(a){if(this.e())return null;var b={},c=0,d=0,e=!0;this.R(R,function(f,g){b[f]=g.J(a);c++;e&&Se.test(f)?d=Math.max(d,Number(f)):e=!1});if(!a&&e&&d<2*c){var f=[],g;for(g in b)f[g]=b[g];return f}a&&!this.C().e()&&(b[".priority"]=this.C().J());return b};h.hash=function(){if(null===this.Gb){var a="";this.C().e()||(a+="priority:"+Re(this.C().J())+":");this.R(R,function(b,c){var d=c.hash();""!==d&&(a+=":"+b+":"+d)});this.Gb=""===a?"":ld(a)}return this.Gb};
h.wf=function(a,b,c){return(c=Te(this,c))?(a=Gc(c,new L(a,b)))?a.name:null:Gc(this.m,a)};function Wd(a,b){var c;c=(c=Te(a,b))?(c=c.Vc())&&c.name:a.m.Vc();return c?new L(c,a.m.get(c)):null}function Xd(a,b){var c;c=(c=Te(a,b))?(c=c.jc())&&c.name:a.m.jc();return c?new L(c,a.m.get(c)):null}h.R=function(a,b){var c=Te(this,a);return c?c.ka(function(a){return b(a.name,a.U)}):this.m.ka(b)};h.ac=function(a){return this.bc(a.Wc(),a)};
h.bc=function(a,b){var c=Te(this,b);if(c)return c.bc(a,function(a){return a});for(var c=this.m.bc(a.name,wc),d=Jc(c);null!=d&&0>b.compare(d,a);)Ic(c),d=Jc(c);return c};h.xf=function(a){return this.dc(a.Tc(),a)};h.dc=function(a,b){var c=Te(this,b);if(c)return c.dc(a,function(a){return a});for(var c=this.m.dc(a.name,wc),d=Jc(c);null!=d&&0<b.compare(d,a);)Ic(c),d=Jc(c);return c};h.Gc=function(a){return this.e()?a.e()?0:-1:a.L()||a.e()?1:a===we?-1:0};
h.pb=function(a){if(a===re||sa(this.Ab.hc,a.toString()))return this;var b=this.Ab,c=this.m;O(a!==re,"KeyIndex always exists and isn't meant to be added to the IndexMap.");for(var d=[],e=!1,c=c.ac(wc),f=Ic(c);f;)e=e||a.Lc(f.U),d.push(f),f=Ic(c);d=e?Me(d,Vd(a)):te;e=a.toString();c=wa(b.hc);c[e]=a;a=wa(b.Ed);a[e]=d;return new fe(this.m,this.ca,new Ke(a,c))};h.Mc=function(a){return a===re||sa(this.Ab.hc,a.toString())};
h.ea=function(a){if(a===this)return!0;if(a.L())return!1;if(this.C().ea(a.C())&&this.m.count()===a.m.count()){var b=this.ac(R);a=a.ac(R);for(var c=Ic(b),d=Ic(a);c&&d;){if(c.name!==d.name||!c.U.ea(d.U))return!1;c=Ic(b);d=Ic(a)}return null===c&&null===d}return!1};function Te(a,b){return b===re?null:a.Ab.get(b.toString())}h.toString=function(){return G(this.J(!0))};function Q(a,b){if(null===a)return H;var c=null;"object"===typeof a&&".priority"in a?c=a[".priority"]:"undefined"!==typeof b&&(c=b);O(null===c||"string"===typeof c||"number"===typeof c||"object"===typeof c&&".sv"in c,"Invalid priority type found: "+typeof c);"object"===typeof a&&".value"in a&&null!==a[".value"]&&(a=a[".value"]);if("object"!==typeof a||".sv"in a)return new Yc(a,Q(c));if(a instanceof Array){var d=H,e=a;v(e,function(a,b){if(y(e,b)&&"."!==b.substring(0,1)){var c=Q(a);if(c.L()||!c.e())d=
d.W(b,c)}});return d.ia(Q(c))}var f=[],g=!1,k=a;Fb(k,function(a){if("string"!==typeof a||"."!==a.substring(0,1)){var b=Q(k[a]);b.e()||(g=g||!b.C().e(),f.push(new L(a,b)))}});if(0==f.length)return H;var m=Me(f,xc,function(a){return a.name},zc);if(g){var l=Me(f,Vd(R));return new fe(m,Q(c),new Ke({".priority":l},{".priority":R}))}return new fe(m,Q(c),Oe)}var Ue=Math.log(2);
function Ve(a){this.count=parseInt(Math.log(a+1)/Ue,10);this.nf=this.count-1;this.ng=a+1&parseInt(Array(this.count+1).join("1"),2)}function We(a){var b=!(a.ng&1<<a.nf);a.nf--;return b}
function Me(a,b,c,d){function e(b,d){var f=d-b;if(0==f)return null;if(1==f){var l=a[b],t=c?c(l):l;return new Kc(t,l.U,!1,null,null)}var l=parseInt(f/2,10)+b,f=e(b,l),A=e(l+1,d),l=a[l],t=c?c(l):l;return new Kc(t,l.U,!1,f,A)}a.sort(b);var f=function(b){function d(b,g){var k=t-b,A=t;t-=b;var A=e(k+1,A),k=a[k],I=c?c(k):k,A=new Kc(I,k.U,g,null,A);f?f.left=A:l=A;f=A}for(var f=null,l=null,t=a.length,A=0;A<b.count;++A){var I=We(b),Qd=Math.pow(2,b.count-(A+1));I?d(Qd,!1):(d(Qd,!1),d(Qd,!0))}return l}(new Ve(a.length));
return null!==f?new Ec(d||b,f):new Ec(d||b)}function Re(a){return"number"===typeof a?"number:"+Ad(a):"string:"+a}function Pe(a){if(a.L()){var b=a.J();O("string"===typeof b||"number"===typeof b||"object"===typeof b&&y(b,".sv"),"Priority must be a string or number.")}else O(a===we||a.e(),"priority of unexpected type.");O(a===we||a.C().e(),"Priority nodes can't have a priority of their own.")}var H=new fe(new Ec(zc),null,Oe);function Xe(){fe.call(this,new Ec(zc),H,Oe)}ka(Xe,fe);h=Xe.prototype;
h.Gc=function(a){return a===this?0:1};h.ea=function(a){return a===this};h.C=function(){return this};h.T=function(){return H};h.e=function(){return!1};var we=new Xe,ue=new L("[MIN_NAME]",H),Ae=new L("[MAX_NAME]",we);function je(a,b){this.Q=a;this.ae=b}function ge(a,b,c,d){return new je(new Xb(b,c,d),a.ae)}function ke(a){return a.Q.ga?a.Q.j():null}je.prototype.w=function(){return this.ae};function Yb(a){return a.ae.ga?a.ae.j():null};function Ye(a,b){this.Y=a;var c=a.n,d=new Ld(c.g),c=He(c)?new Ld(c.g):c.la?new Sd(c):new Md(c);this.Nf=new Zd(c);var e=b.w(),f=b.Q,g=d.ya(H,e.j(),null),k=c.ya(H,f.j(),null);this.Oa=new je(new Xb(k,f.ga,c.Ra()),new Xb(g,e.ga,d.Ra()));this.$a=[];this.ug=new Fd(a)}function Ze(a){return a.Y}h=Ye.prototype;h.w=function(){return this.Oa.w().j()};h.kb=function(a){var b=Yb(this.Oa);return b&&(He(this.Y.n)||!a.e()&&!b.T(K(a)).e())?b.S(a):null};h.e=function(){return 0===this.$a.length};h.Tb=function(a){this.$a.push(a)};
h.nb=function(a,b){var c=[];if(b){O(null==a,"A cancel should cancel all event registrations.");var d=this.Y.path;Ma(this.$a,function(a){(a=a.lf(b,d))&&c.push(a)})}if(a){for(var e=[],f=0;f<this.$a.length;++f){var g=this.$a[f];if(!g.matches(a))e.push(g);else if(a.yf()){e=e.concat(this.$a.slice(f+1));break}}this.$a=e}else this.$a=[];return c};
h.gb=function(a,b,c){a.type===be&&null!==a.source.Lb&&(O(Yb(this.Oa),"We should always have a full cache before handling merges"),O(ke(this.Oa),"Missing event cache, even though we have a server cache"));var d=this.Oa;a=this.Nf.gb(d,a,b,c);b=this.Nf;c=a.me;O(c.Q.j().Mc(b.X.g),"Event snap not indexed");O(c.w().j().Mc(b.X.g),"Server snap not indexed");O(lc(a.me.w())||!lc(d.w()),"Once a server snap is complete, it should never go back");this.Oa=a.me;return $e(this,a.og,a.me.Q.j(),null)};
function af(a,b){var c=a.Oa.Q,d=[];c.j().L()||c.j().R(R,function(a,b){d.push(new J("child_added",b,a))});c.ga&&d.push(hc(c.j()));return $e(a,d,c.j(),b)}function $e(a,b,c,d){return Gd(a.ug,b,c,d?[d]:a.$a)};function bf(a,b,c){this.type=be;this.source=a;this.path=b;this.children=c}bf.prototype.$c=function(a){if(this.path.e())return a=this.children.subtree(new P(a)),a.e()?null:a.value?new Ac(this.source,M,a.value):new bf(this.source,M,a);O(K(this.path)===a,"Can't get a merge for a child not on the path of the operation");return new bf(this.source,N(this.path),this.children)};bf.prototype.toString=function(){return"Operation("+this.path+": "+this.source.toString()+" merge: "+this.children.toString()+")"};function cf(a,b){this.f=pd("p:rest:");this.G=a;this.Kb=b;this.Ca=null;this.ba={}}function df(a,b){if(p(b))return"tag$"+b;O(Ie(a.n),"should have a tag if it's not a default query.");return a.path.toString()}h=cf.prototype;
h.Cf=function(a,b,c,d){var e=a.path.toString();this.f("Listen called for "+e+" "+a.wa());var f=df(a,c),g={};this.ba[f]=g;a=Je(a.n);var k=this;ef(this,e+".json",a,function(a,b){var t=b;404===a&&(a=t=null);null===a&&k.Kb(e,t,!1,c);z(k.ba,f)===g&&d(a?401==a?"permission_denied":"rest_error:"+a:"ok",null)})};h.$f=function(a,b){var c=df(a,b);delete this.ba[c]};h.O=function(a,b){this.Ca=a;var c=Cd(a),d=c.data,c=c.Ec&&c.Ec.exp;b&&b("ok",{auth:d,expires:c})};h.je=function(a){this.Ca=null;a("ok",null)};
h.Qe=function(){};h.Gf=function(){};h.Md=function(){};h.put=function(){};h.Df=function(){};h.Ye=function(){};
function ef(a,b,c,d){c=c||{};c.format="export";a.Ca&&(c.auth=a.Ca);var e=(a.G.ob?"https://":"http://")+a.G.host+b+"?"+Ib(c);a.f("Sending REST request for "+e);var f=new XMLHttpRequest;f.onreadystatechange=function(){if(d&&4===f.readyState){a.f("REST Response for "+e+" received. status:",f.status,"response:",f.responseText);var b=null;if(200<=f.status&&300>f.status){try{b=Rb(f.responseText)}catch(c){S("Failed to parse JSON response for "+e+": "+f.responseText)}d(null,b)}else 401!==f.status&&404!==
f.status&&S("Got unsuccessful REST response for "+e+" Status: "+f.status),d(f.status);d=null}};f.open("GET",e,!0);f.send()};function ff(a){O(da(a)&&0<a.length,"Requires a non-empty array");this.fg=a;this.Rc={}}ff.prototype.ie=function(a,b){var c;c=this.Rc[a]||[];var d=c.length;if(0<d){for(var e=Array(d),f=0;f<d;f++)e[f]=c[f];c=e}else c=[];for(d=0;d<c.length;d++)c[d].Dc.apply(c[d].Qa,Array.prototype.slice.call(arguments,1))};ff.prototype.Ib=function(a,b,c){gf(this,a);this.Rc[a]=this.Rc[a]||[];this.Rc[a].push({Dc:b,Qa:c});(a=this.Ee(a))&&b.apply(c,a)};
ff.prototype.mc=function(a,b,c){gf(this,a);a=this.Rc[a]||[];for(var d=0;d<a.length;d++)if(a[d].Dc===b&&(!c||c===a[d].Qa)){a.splice(d,1);break}};function gf(a,b){O(Ra(a.fg,function(a){return a===b}),"Unknown event: "+b)};var hf=function(){var a=0,b=[];return function(c){var d=c===a;a=c;for(var e=Array(8),f=7;0<=f;f--)e[f]="-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(c%64),c=Math.floor(c/64);O(0===c,"Cannot push at time == 0");c=e.join("");if(d){for(f=11;0<=f&&63===b[f];f--)b[f]=0;b[f]++}else for(f=0;12>f;f++)b[f]=Math.floor(64*Math.random());for(f=0;12>f;f++)c+="-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz".charAt(b[f]);O(20===c.length,"nextPushId: Length should be 20.");
return c}}();function jf(){ff.call(this,["online"]);this.oc=!0;if("undefined"!==typeof window&&"undefined"!==typeof window.addEventListener){var a=this;window.addEventListener("online",function(){a.oc||(a.oc=!0,a.ie("online",!0))},!1);window.addEventListener("offline",function(){a.oc&&(a.oc=!1,a.ie("online",!1))},!1)}}ka(jf,ff);jf.prototype.Ee=function(a){O("online"===a,"Unknown event type: "+a);return[this.oc]};ba(jf);function kf(){ff.call(this,["visible"]);var a,b;"undefined"!==typeof document&&"undefined"!==typeof document.addEventListener&&("undefined"!==typeof document.hidden?(b="visibilitychange",a="hidden"):"undefined"!==typeof document.mozHidden?(b="mozvisibilitychange",a="mozHidden"):"undefined"!==typeof document.msHidden?(b="msvisibilitychange",a="msHidden"):"undefined"!==typeof document.webkitHidden&&(b="webkitvisibilitychange",a="webkitHidden"));this.Sb=!0;if(b){var c=this;document.addEventListener(b,
function(){var b=!document[a];b!==c.Sb&&(c.Sb=b,c.ie("visible",b))},!1)}}ka(kf,ff);kf.prototype.Ee=function(a){O("visible"===a,"Unknown event type: "+a);return[this.Sb]};ba(kf);function P(a,b){if(1==arguments.length){this.u=a.split("/");for(var c=0,d=0;d<this.u.length;d++)0<this.u[d].length&&(this.u[c]=this.u[d],c++);this.u.length=c;this.aa=0}else this.u=a,this.aa=b}function lf(a,b){var c=K(a);if(null===c)return b;if(c===K(b))return lf(N(a),N(b));throw Error("INTERNAL ERROR: innerPath ("+b+") is not within outerPath ("+a+")");}
function mf(a,b){for(var c=a.slice(),d=b.slice(),e=0;e<c.length&&e<d.length;e++){var f=yc(c[e],d[e]);if(0!==f)return f}return c.length===d.length?0:c.length<d.length?-1:1}function K(a){return a.aa>=a.u.length?null:a.u[a.aa]}function le(a){return a.u.length-a.aa}function N(a){var b=a.aa;b<a.u.length&&b++;return new P(a.u,b)}function me(a){return a.aa<a.u.length?a.u[a.u.length-1]:null}h=P.prototype;
h.toString=function(){for(var a="",b=this.aa;b<this.u.length;b++)""!==this.u[b]&&(a+="/"+this.u[b]);return a||"/"};h.slice=function(a){return this.u.slice(this.aa+(a||0))};h.parent=function(){if(this.aa>=this.u.length)return null;for(var a=[],b=this.aa;b<this.u.length-1;b++)a.push(this.u[b]);return new P(a,0)};
h.o=function(a){for(var b=[],c=this.aa;c<this.u.length;c++)b.push(this.u[c]);if(a instanceof P)for(c=a.aa;c<a.u.length;c++)b.push(a.u[c]);else for(a=a.split("/"),c=0;c<a.length;c++)0<a[c].length&&b.push(a[c]);return new P(b,0)};h.e=function(){return this.aa>=this.u.length};h.ea=function(a){if(le(this)!==le(a))return!1;for(var b=this.aa,c=a.aa;b<=this.u.length;b++,c++)if(this.u[b]!==a.u[c])return!1;return!0};
h.contains=function(a){var b=this.aa,c=a.aa;if(le(this)>le(a))return!1;for(;b<this.u.length;){if(this.u[b]!==a.u[c])return!1;++b;++c}return!0};var M=new P("");function nf(a,b){this.Ua=a.slice();this.Ka=Math.max(1,this.Ua.length);this.pf=b;for(var c=0;c<this.Ua.length;c++)this.Ka+=Pb(this.Ua[c]);of(this)}nf.prototype.push=function(a){0<this.Ua.length&&(this.Ka+=1);this.Ua.push(a);this.Ka+=Pb(a);of(this)};nf.prototype.pop=function(){var a=this.Ua.pop();this.Ka-=Pb(a);0<this.Ua.length&&--this.Ka};
function of(a){if(768<a.Ka)throw Error(a.pf+"has a key path longer than 768 bytes ("+a.Ka+").");if(32<a.Ua.length)throw Error(a.pf+"path specified exceeds the maximum depth that can be written (32) or object contains a cycle "+pf(a));}function pf(a){return 0==a.Ua.length?"":"in property '"+a.Ua.join(".")+"'"};function qf(a,b){this.value=a;this.children=b||rf}var rf=new Ec(function(a,b){return a===b?0:a<b?-1:1});function sf(a){var b=qe;v(a,function(a,d){b=b.set(new P(d),a)});return b}h=qf.prototype;h.e=function(){return null===this.value&&this.children.e()};function tf(a,b,c){if(null!=a.value&&c(a.value))return{path:M,value:a.value};if(b.e())return null;var d=K(b);a=a.children.get(d);return null!==a?(b=tf(a,N(b),c),null!=b?{path:(new P(d)).o(b.path),value:b.value}:null):null}
function uf(a,b){return tf(a,b,function(){return!0})}h.subtree=function(a){if(a.e())return this;var b=this.children.get(K(a));return null!==b?b.subtree(N(a)):qe};h.set=function(a,b){if(a.e())return new qf(b,this.children);var c=K(a),d=(this.children.get(c)||qe).set(N(a),b),c=this.children.Sa(c,d);return new qf(this.value,c)};
h.remove=function(a){if(a.e())return this.children.e()?qe:new qf(null,this.children);var b=K(a),c=this.children.get(b);return c?(a=c.remove(N(a)),b=a.e()?this.children.remove(b):this.children.Sa(b,a),null===this.value&&b.e()?qe:new qf(this.value,b)):this};h.get=function(a){if(a.e())return this.value;var b=this.children.get(K(a));return b?b.get(N(a)):null};
function pe(a,b,c){if(b.e())return c;var d=K(b);b=pe(a.children.get(d)||qe,N(b),c);d=b.e()?a.children.remove(d):a.children.Sa(d,b);return new qf(a.value,d)}function vf(a,b){return wf(a,M,b)}function wf(a,b,c){var d={};a.children.ka(function(a,f){d[a]=wf(f,b.o(a),c)});return c(b,a.value,d)}function xf(a,b,c){return yf(a,b,M,c)}function yf(a,b,c,d){var e=a.value?d(c,a.value):!1;if(e)return e;if(b.e())return null;e=K(b);return(a=a.children.get(e))?yf(a,N(b),c.o(e),d):null}
function zf(a,b,c){Af(a,b,M,c)}function Af(a,b,c,d){if(b.e())return a;a.value&&d(c,a.value);var e=K(b);return(a=a.children.get(e))?Af(a,N(b),c.o(e),d):qe}function ne(a,b){Bf(a,M,b)}function Bf(a,b,c){a.children.ka(function(a,e){Bf(e,b.o(a),c)});a.value&&c(b,a.value)}function Cf(a,b){a.children.ka(function(a,d){d.value&&b(a,d.value)})}var qe=new qf(null);qf.prototype.toString=function(){var a={};ne(this,function(b,c){a[b.toString()]=c.toString()});return G(a)};function Df(a,b,c){this.type=ee;this.source=Ef;this.path=a;this.Ub=b;this.Yd=c}Df.prototype.$c=function(a){if(this.path.e()){if(null!=this.Ub.value)return O(this.Ub.children.e(),"affectedTree should not have overlapping affected paths."),this;a=this.Ub.subtree(new P(a));return new Df(M,a,this.Yd)}O(K(this.path)===a,"operationForChild called for unrelated child.");return new Df(N(this.path),this.Ub,this.Yd)};
Df.prototype.toString=function(){return"Operation("+this.path+": "+this.source.toString()+" ack write revert="+this.Yd+" affectedTree="+this.Ub+")"};var Bc=0,be=1,ee=2,Dc=3;function Ff(a,b,c,d){this.Ae=a;this.tf=b;this.Lb=c;this.ef=d;O(!d||b,"Tagged queries must be from server.")}var Ef=new Ff(!0,!1,null,!1),Gf=new Ff(!1,!0,null,!1);Ff.prototype.toString=function(){return this.Ae?"user":this.ef?"server(queryID="+this.Lb+")":"server"};function Hf(a){this.Z=a}var If=new Hf(new qf(null));function Jf(a,b,c){if(b.e())return new Hf(new qf(c));var d=uf(a.Z,b);if(null!=d){var e=d.path,d=d.value;b=lf(e,b);d=d.H(b,c);return new Hf(a.Z.set(e,d))}a=pe(a.Z,b,new qf(c));return new Hf(a)}function Kf(a,b,c){var d=a;Fb(c,function(a,c){d=Jf(d,b.o(a),c)});return d}Hf.prototype.Ud=function(a){if(a.e())return If;a=pe(this.Z,a,qe);return new Hf(a)};function Lf(a,b){var c=uf(a.Z,b);return null!=c?a.Z.get(c.path).S(lf(c.path,b)):null}
function Mf(a){var b=[],c=a.Z.value;null!=c?c.L()||c.R(R,function(a,c){b.push(new L(a,c))}):a.Z.children.ka(function(a,c){null!=c.value&&b.push(new L(a,c.value))});return b}function Nf(a,b){if(b.e())return a;var c=Lf(a,b);return null!=c?new Hf(new qf(c)):new Hf(a.Z.subtree(b))}Hf.prototype.e=function(){return this.Z.e()};Hf.prototype.apply=function(a){return Of(M,this.Z,a)};
function Of(a,b,c){if(null!=b.value)return c.H(a,b.value);var d=null;b.children.ka(function(b,f){".priority"===b?(O(null!==f.value,"Priority writes must always be leaf nodes"),d=f.value):c=Of(a.o(b),f,c)});c.S(a).e()||null===d||(c=c.H(a.o(".priority"),d));return c};function Pf(){this.V=If;this.pa=[];this.Pc=-1}function Qf(a,b){for(var c=0;c<a.pa.length;c++){var d=a.pa[c];if(d.md===b)return d}return null}h=Pf.prototype;
h.Ud=function(a){var b=Sa(this.pa,function(b){return b.md===a});O(0<=b,"removeWrite called with nonexistent writeId.");var c=this.pa[b];this.pa.splice(b,1);for(var d=c.visible,e=!1,f=this.pa.length-1;d&&0<=f;){var g=this.pa[f];g.visible&&(f>=b&&Rf(g,c.path)?d=!1:c.path.contains(g.path)&&(e=!0));f--}if(d){if(e)this.V=Sf(this.pa,Tf,M),this.Pc=0<this.pa.length?this.pa[this.pa.length-1].md:-1;else if(c.Ja)this.V=this.V.Ud(c.path);else{var k=this;v(c.children,function(a,b){k.V=k.V.Ud(c.path.o(b))})}return!0}return!1};
h.Aa=function(a,b,c,d){if(c||d){var e=Nf(this.V,a);return!d&&e.e()?b:d||null!=b||null!=Lf(e,M)?(e=Sf(this.pa,function(b){return(b.visible||d)&&(!c||!(0<=La(c,b.md)))&&(b.path.contains(a)||a.contains(b.path))},a),b=b||H,e.apply(b)):null}e=Lf(this.V,a);if(null!=e)return e;e=Nf(this.V,a);return e.e()?b:null!=b||null!=Lf(e,M)?(b=b||H,e.apply(b)):null};
h.Cc=function(a,b){var c=H,d=Lf(this.V,a);if(d)d.L()||d.R(R,function(a,b){c=c.W(a,b)});else if(b){var e=Nf(this.V,a);b.R(R,function(a,b){var d=Nf(e,new P(a)).apply(b);c=c.W(a,d)});Ma(Mf(e),function(a){c=c.W(a.name,a.U)})}else e=Nf(this.V,a),Ma(Mf(e),function(a){c=c.W(a.name,a.U)});return c};h.nd=function(a,b,c,d){O(c||d,"Either existingEventSnap or existingServerSnap must exist");a=a.o(b);if(null!=Lf(this.V,a))return null;a=Nf(this.V,a);return a.e()?d.S(b):a.apply(d.S(b))};
h.Bc=function(a,b,c){a=a.o(b);var d=Lf(this.V,a);return null!=d?d:Wb(c,b)?Nf(this.V,a).apply(c.j().T(b)):null};h.xc=function(a){return Lf(this.V,a)};h.qe=function(a,b,c,d,e,f){var g;a=Nf(this.V,a);g=Lf(a,M);if(null==g)if(null!=b)g=a.apply(b);else return[];g=g.pb(f);if(g.e()||g.L())return[];b=[];a=Vd(f);e=e?g.dc(c,f):g.bc(c,f);for(f=Ic(e);f&&b.length<d;)0!==a(f,c)&&b.push(f),f=Ic(e);return b};
function Rf(a,b){return a.Ja?a.path.contains(b):!!ta(a.children,function(c,d){return a.path.o(d).contains(b)})}function Tf(a){return a.visible}
function Sf(a,b,c){for(var d=If,e=0;e<a.length;++e){var f=a[e];if(b(f)){var g=f.path;if(f.Ja)c.contains(g)?(g=lf(c,g),d=Jf(d,g,f.Ja)):g.contains(c)&&(g=lf(g,c),d=Jf(d,M,f.Ja.S(g)));else if(f.children)if(c.contains(g))g=lf(c,g),d=Kf(d,g,f.children);else{if(g.contains(c))if(g=lf(g,c),g.e())d=Kf(d,M,f.children);else if(f=z(f.children,K(g)))f=f.S(N(g)),d=Jf(d,M,f)}else throw jd("WriteRecord should have .snap or .children");}}return d}function Uf(a,b){this.Qb=a;this.Z=b}h=Uf.prototype;
h.Aa=function(a,b,c){return this.Z.Aa(this.Qb,a,b,c)};h.Cc=function(a){return this.Z.Cc(this.Qb,a)};h.nd=function(a,b,c){return this.Z.nd(this.Qb,a,b,c)};h.xc=function(a){return this.Z.xc(this.Qb.o(a))};h.qe=function(a,b,c,d,e){return this.Z.qe(this.Qb,a,b,c,d,e)};h.Bc=function(a,b){return this.Z.Bc(this.Qb,a,b)};h.o=function(a){return new Uf(this.Qb.o(a),this.Z)};function Vf(){this.children={};this.pd=0;this.value=null}function Wf(a,b,c){this.Jd=a?a:"";this.Ha=b?b:null;this.A=c?c:new Vf}function Xf(a,b){for(var c=b instanceof P?b:new P(b),d=a,e;null!==(e=K(c));)d=new Wf(e,d,z(d.A.children,e)||new Vf),c=N(c);return d}h=Wf.prototype;h.Ea=function(){return this.A.value};function Yf(a,b){O("undefined"!==typeof b,"Cannot set value to undefined");a.A.value=b;Zf(a)}h.clear=function(){this.A.value=null;this.A.children={};this.A.pd=0;Zf(this)};
h.zd=function(){return 0<this.A.pd};h.e=function(){return null===this.Ea()&&!this.zd()};h.R=function(a){var b=this;v(this.A.children,function(c,d){a(new Wf(d,b,c))})};function $f(a,b,c,d){c&&!d&&b(a);a.R(function(a){$f(a,b,!0,d)});c&&d&&b(a)}function ag(a,b){for(var c=a.parent();null!==c&&!b(c);)c=c.parent()}h.path=function(){return new P(null===this.Ha?this.Jd:this.Ha.path()+"/"+this.Jd)};h.name=function(){return this.Jd};h.parent=function(){return this.Ha};
function Zf(a){if(null!==a.Ha){var b=a.Ha,c=a.Jd,d=a.e(),e=y(b.A.children,c);d&&e?(delete b.A.children[c],b.A.pd--,Zf(b)):d||e||(b.A.children[c]=a.A,b.A.pd++,Zf(b))}};var bg=/[\[\].#$\/\u0000-\u001F\u007F]/,cg=/[\[\].#$\u0000-\u001F\u007F]/,dg=/^[a-zA-Z][a-zA-Z._\-+]+$/;function eg(a){return q(a)&&0!==a.length&&!bg.test(a)}function fg(a){return null===a||q(a)||fa(a)&&!td(a)||ga(a)&&y(a,".sv")}function gg(a,b,c,d){d&&!p(b)||hg(E(a,1,d),b,c)}
function hg(a,b,c){c instanceof P&&(c=new nf(c,a));if(!p(b))throw Error(a+"contains undefined "+pf(c));if(r(b))throw Error(a+"contains a function "+pf(c)+" with contents: "+b.toString());if(td(b))throw Error(a+"contains "+b.toString()+" "+pf(c));if(q(b)&&b.length>10485760/3&&10485760<Pb(b))throw Error(a+"contains a string greater than 10485760 utf8 bytes "+pf(c)+" ('"+b.substring(0,50)+"...')");if(ga(b)){var d=!1,e=!1;Fb(b,function(b,g){if(".value"===b)d=!0;else if(".priority"!==b&&".sv"!==b&&(e=
!0,!eg(b)))throw Error(a+" contains an invalid key ("+b+") "+pf(c)+'.  Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');c.push(b);hg(a,g,c);c.pop()});if(d&&e)throw Error(a+' contains ".value" child '+pf(c)+" in addition to actual children.");}}
function ig(a,b){var c,d;for(c=0;c<b.length;c++){d=b[c];for(var e=d.slice(),f=0;f<e.length;f++)if((".priority"!==e[f]||f!==e.length-1)&&!eg(e[f]))throw Error(a+"contains an invalid key ("+e[f]+") in path "+d.toString()+'. Keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]"');}b.sort(mf);e=null;for(c=0;c<b.length;c++){d=b[c];if(null!==e&&e.contains(d))throw Error(a+"contains a path "+e.toString()+" that is ancestor of another path "+d.toString());e=d}}
function jg(a,b,c){var d=E(a,1,!1);if(!ga(b)||da(b))throw Error(d+" must be an object containing the children to replace.");var e=[];Fb(b,function(a,b){var k=new P(a);hg(d,b,c.o(k));if(".priority"===me(k)&&!fg(b))throw Error(d+"contains an invalid value for '"+k.toString()+"', which must be a valid Firebase priority (a string, finite number, server value, or null).");e.push(k)});ig(d,e)}
function kg(a,b,c){if(td(c))throw Error(E(a,b,!1)+"is "+c.toString()+", but must be a valid Firebase priority (a string, finite number, server value, or null).");if(!fg(c))throw Error(E(a,b,!1)+"must be a valid Firebase priority (a string, finite number, server value, or null).");}
function lg(a,b,c){if(!c||p(b))switch(b){case "value":case "child_added":case "child_removed":case "child_changed":case "child_moved":break;default:throw Error(E(a,1,c)+'must be a valid event type: "value", "child_added", "child_removed", "child_changed", or "child_moved".');}}function mg(a,b){if(p(b)&&!eg(b))throw Error(E(a,2,!0)+'was an invalid key: "'+b+'".  Firebase keys must be non-empty strings and can\'t contain ".", "#", "$", "/", "[", or "]").');}
function ng(a,b){if(!q(b)||0===b.length||cg.test(b))throw Error(E(a,1,!1)+'was an invalid path: "'+b+'". Paths must be non-empty strings and can\'t contain ".", "#", "$", "[", or "]"');}function og(a,b){if(".info"===K(b))throw Error(a+" failed: Can't modify data under /.info/");}function pg(a,b){if(!q(b))throw Error(E(a,1,!1)+"must be a valid credential (a string).");}function qg(a,b,c){if(!q(c))throw Error(E(a,b,!1)+"must be a valid string.");}
function rg(a,b){qg(a,1,b);if(!dg.test(b))throw Error(E(a,1,!1)+"'"+b+"' is not a valid authentication provider.");}function sg(a,b,c,d){if(!d||p(c))if(!ga(c)||null===c)throw Error(E(a,b,d)+"must be a valid object.");}function tg(a,b,c){if(!ga(b)||!y(b,c))throw Error(E(a,1,!1)+'must contain the key "'+c+'"');if(!q(z(b,c)))throw Error(E(a,1,!1)+'must contain the key "'+c+'" with type "string"');};function ug(){this.set={}}h=ug.prototype;h.add=function(a,b){this.set[a]=null!==b?b:!0};h.contains=function(a){return y(this.set,a)};h.get=function(a){return this.contains(a)?this.set[a]:void 0};h.remove=function(a){delete this.set[a]};h.clear=function(){this.set={}};h.e=function(){return va(this.set)};h.count=function(){return oa(this.set)};function vg(a,b){v(a.set,function(a,d){b(d,a)})}h.keys=function(){var a=[];v(this.set,function(b,c){a.push(c)});return a};function Vc(){this.m=this.B=null}Vc.prototype.find=function(a){if(null!=this.B)return this.B.S(a);if(a.e()||null==this.m)return null;var b=K(a);a=N(a);return this.m.contains(b)?this.m.get(b).find(a):null};Vc.prototype.rc=function(a,b){if(a.e())this.B=b,this.m=null;else if(null!==this.B)this.B=this.B.H(a,b);else{null==this.m&&(this.m=new ug);var c=K(a);this.m.contains(c)||this.m.add(c,new Vc);c=this.m.get(c);a=N(a);c.rc(a,b)}};
function wg(a,b){if(b.e())return a.B=null,a.m=null,!0;if(null!==a.B){if(a.B.L())return!1;var c=a.B;a.B=null;c.R(R,function(b,c){a.rc(new P(b),c)});return wg(a,b)}return null!==a.m?(c=K(b),b=N(b),a.m.contains(c)&&wg(a.m.get(c),b)&&a.m.remove(c),a.m.e()?(a.m=null,!0):!1):!0}function Wc(a,b,c){null!==a.B?c(b,a.B):a.R(function(a,e){var f=new P(b.toString()+"/"+a);Wc(e,f,c)})}Vc.prototype.R=function(a){null!==this.m&&vg(this.m,function(b,c){a(b,c)})};var xg="auth.firebase.com";function yg(a,b,c){this.qd=a||{};this.he=b||{};this.fb=c||{};this.qd.remember||(this.qd.remember="default")}var zg=["remember","redirectTo"];function Ag(a){var b={},c={};Fb(a||{},function(a,e){0<=La(zg,a)?b[a]=e:c[a]=e});return new yg(b,{},c)};function Bg(a,b){this.Ue=["session",a.Rd,a.lc].join(":");this.ee=b}Bg.prototype.set=function(a,b){if(!b)if(this.ee.length)b=this.ee[0];else throw Error("fb.login.SessionManager : No storage options available!");b.set(this.Ue,a)};Bg.prototype.get=function(){var a=Oa(this.ee,u(this.Bg,this)),a=Na(a,function(a){return null!==a});Va(a,function(a,c){return Dd(c.token)-Dd(a.token)});return 0<a.length?a.shift():null};Bg.prototype.Bg=function(a){try{var b=a.get(this.Ue);if(b&&b.token)return b}catch(c){}return null};
Bg.prototype.clear=function(){var a=this;Ma(this.ee,function(b){b.remove(a.Ue)})};function Cg(){return"undefined"!==typeof navigator&&"string"===typeof navigator.userAgent?navigator.userAgent:""}function Dg(){return"undefined"!==typeof window&&!!(window.cordova||window.phonegap||window.PhoneGap)&&/ios|iphone|ipod|ipad|android|blackberry|iemobile/i.test(Cg())}function Eg(){return"undefined"!==typeof location&&/^file:\//.test(location.href)}
function Fg(a){var b=Cg();if(""===b)return!1;if("Microsoft Internet Explorer"===navigator.appName){if((b=b.match(/MSIE ([0-9]{1,}[\.0-9]{0,})/))&&1<b.length)return parseFloat(b[1])>=a}else if(-1<b.indexOf("Trident")&&(b=b.match(/rv:([0-9]{2,2}[\.0-9]{0,})/))&&1<b.length)return parseFloat(b[1])>=a;return!1};function Gg(){var a=window.opener.frames,b;for(b=a.length-1;0<=b;b--)try{if(a[b].location.protocol===window.location.protocol&&a[b].location.host===window.location.host&&"__winchan_relay_frame"===a[b].name)return a[b]}catch(c){}return null}function Hg(a,b,c){a.attachEvent?a.attachEvent("on"+b,c):a.addEventListener&&a.addEventListener(b,c,!1)}function Ig(a,b,c){a.detachEvent?a.detachEvent("on"+b,c):a.removeEventListener&&a.removeEventListener(b,c,!1)}
function Jg(a){/^https?:\/\//.test(a)||(a=window.location.href);var b=/^(https?:\/\/[\-_a-zA-Z\.0-9:]+)/.exec(a);return b?b[1]:a}function Kg(a){var b="";try{a=a.replace(/.*\?/,"");var c=Jb(a);c&&y(c,"__firebase_request_key")&&(b=z(c,"__firebase_request_key"))}catch(d){}return b}function Lg(){try{var a=document.location.hash.replace(/&__firebase_request_key=([a-zA-z0-9]*)/,""),a=a.replace(/\?$/,""),a=a.replace(/^#+$/,"");document.location.hash=a}catch(b){}}
function Mg(){var a=sd(xg);return a.scheme+"://"+a.host+"/v2"}function Ng(a){return Mg()+"/"+a+"/auth/channel"};function Og(a){var b=this;this.hb=a;this.fe="*";Fg(8)?this.Uc=this.Cd=Gg():(this.Uc=window.opener,this.Cd=window);if(!b.Uc)throw"Unable to find relay frame";Hg(this.Cd,"message",u(this.nc,this));Hg(this.Cd,"message",u(this.Ff,this));try{Pg(this,{a:"ready"})}catch(c){Hg(this.Uc,"load",function(){Pg(b,{a:"ready"})})}Hg(window,"unload",u(this.Ng,this))}function Pg(a,b){b=G(b);Fg(8)?a.Uc.doPost(b,a.fe):a.Uc.postMessage(b,a.fe)}
Og.prototype.nc=function(a){var b=this,c;try{c=Rb(a.data)}catch(d){}c&&"request"===c.a&&(Ig(window,"message",this.nc),this.fe=a.origin,this.hb&&setTimeout(function(){b.hb(b.fe,c.d,function(a,c){b.mg=!c;b.hb=void 0;Pg(b,{a:"response",d:a,forceKeepWindowOpen:c})})},0))};Og.prototype.Ng=function(){try{Ig(this.Cd,"message",this.Ff)}catch(a){}this.hb&&(Pg(this,{a:"error",d:"unknown closed window"}),this.hb=void 0);try{window.close()}catch(b){}};Og.prototype.Ff=function(a){if(this.mg&&"die"===a.data)try{window.close()}catch(b){}};function Qg(a){this.tc=Fa()+Fa()+Fa();this.Kf=a}Qg.prototype.open=function(a,b){cd.set("redirect_request_id",this.tc);cd.set("redirect_request_id",this.tc);b.requestId=this.tc;b.redirectTo=b.redirectTo||window.location.href;a+=(/\?/.test(a)?"":"?")+Ib(b);window.location=a};Qg.isAvailable=function(){return!Eg()&&!Dg()};Qg.prototype.Fc=function(){return"redirect"};var Rg={NETWORK_ERROR:"Unable to contact the Firebase server.",SERVER_ERROR:"An unknown server error occurred.",TRANSPORT_UNAVAILABLE:"There are no login transports available for the requested method.",REQUEST_INTERRUPTED:"The browser redirected the page before the login request could complete.",USER_CANCELLED:"The user cancelled authentication."};function Sg(a){var b=Error(z(Rg,a),a);b.code=a;return b};function Tg(a){var b;(b=!a.window_features)||(b=Cg(),b=-1!==b.indexOf("Fennec/")||-1!==b.indexOf("Firefox/")&&-1!==b.indexOf("Android"));b&&(a.window_features=void 0);a.window_name||(a.window_name="_blank");this.options=a}
Tg.prototype.open=function(a,b,c){function d(a){g&&(document.body.removeChild(g),g=void 0);t&&(t=clearInterval(t));Ig(window,"message",e);Ig(window,"unload",d);if(l&&!a)try{l.close()}catch(b){k.postMessage("die",m)}l=k=void 0}function e(a){if(a.origin===m)try{var b=Rb(a.data);"ready"===b.a?k.postMessage(A,m):"error"===b.a?(d(!1),c&&(c(b.d),c=null)):"response"===b.a&&(d(b.forceKeepWindowOpen),c&&(c(null,b.d),c=null))}catch(e){}}var f=Fg(8),g,k;if(!this.options.relay_url)return c(Error("invalid arguments: origin of url and relay_url must match"));
var m=Jg(a);if(m!==Jg(this.options.relay_url))c&&setTimeout(function(){c(Error("invalid arguments: origin of url and relay_url must match"))},0);else{f&&(g=document.createElement("iframe"),g.setAttribute("src",this.options.relay_url),g.style.display="none",g.setAttribute("name","__winchan_relay_frame"),document.body.appendChild(g),k=g.contentWindow);a+=(/\?/.test(a)?"":"?")+Ib(b);var l=window.open(a,this.options.window_name,this.options.window_features);k||(k=l);var t=setInterval(function(){l&&l.closed&&
(d(!1),c&&(c(Sg("USER_CANCELLED")),c=null))},500),A=G({a:"request",d:b});Hg(window,"unload",d);Hg(window,"message",e)}};
Tg.isAvailable=function(){var a;if(a="postMessage"in window&&!Eg())(a=Dg()||"undefined"!==typeof navigator&&(!!Cg().match(/Windows Phone/)||!!window.Windows&&/^ms-appx:/.test(location.href)))||(a=Cg(),a="undefined"!==typeof navigator&&"undefined"!==typeof window&&!!(a.match(/(iPhone|iPod|iPad).*AppleWebKit(?!.*Safari)/i)||a.match(/CriOS/)||a.match(/Twitter for iPhone/)||a.match(/FBAN\/FBIOS/)||window.navigator.standalone)),a=!a;return a&&!Cg().match(/PhantomJS/)};Tg.prototype.Fc=function(){return"popup"};function Ug(a){a.method||(a.method="GET");a.headers||(a.headers={});a.headers.content_type||(a.headers.content_type="application/json");a.headers.content_type=a.headers.content_type.toLowerCase();this.options=a}
Ug.prototype.open=function(a,b,c){function d(){c&&(c(Sg("REQUEST_INTERRUPTED")),c=null)}var e=new XMLHttpRequest,f=this.options.method.toUpperCase(),g;Hg(window,"beforeunload",d);e.onreadystatechange=function(){if(c&&4===e.readyState){var a;if(200<=e.status&&300>e.status){try{a=Rb(e.responseText)}catch(b){}c(null,a)}else 500<=e.status&&600>e.status?c(Sg("SERVER_ERROR")):c(Sg("NETWORK_ERROR"));c=null;Ig(window,"beforeunload",d)}};if("GET"===f)a+=(/\?/.test(a)?"":"?")+Ib(b),g=null;else{var k=this.options.headers.content_type;
"application/json"===k&&(g=G(b));"application/x-www-form-urlencoded"===k&&(g=Ib(b))}e.open(f,a,!0);a={"X-Requested-With":"XMLHttpRequest",Accept:"application/json;text/plain"};ya(a,this.options.headers);for(var m in a)e.setRequestHeader(m,a[m]);e.send(g)};Ug.isAvailable=function(){var a;if(a=!!window.XMLHttpRequest)a=Cg(),a=!(a.match(/MSIE/)||a.match(/Trident/))||Fg(10);return a};Ug.prototype.Fc=function(){return"json"};function Vg(a){this.tc=Fa()+Fa()+Fa();this.Kf=a}
Vg.prototype.open=function(a,b,c){function d(){c&&(c(Sg("USER_CANCELLED")),c=null)}var e=this,f=sd(xg),g;b.requestId=this.tc;b.redirectTo=f.scheme+"://"+f.host+"/blank/page.html";a+=/\?/.test(a)?"":"?";a+=Ib(b);(g=window.open(a,"_blank","location=no"))&&r(g.addEventListener)?(g.addEventListener("loadstart",function(a){var b;if(b=a&&a.url)a:{try{var l=document.createElement("a");l.href=a.url;b=l.host===f.host&&"/blank/page.html"===l.pathname;break a}catch(t){}b=!1}b&&(a=Kg(a.url),g.removeEventListener("exit",
d),g.close(),a=new yg(null,null,{requestId:e.tc,requestKey:a}),e.Kf.requestWithCredential("/auth/session",a,c),c=null)}),g.addEventListener("exit",d)):c(Sg("TRANSPORT_UNAVAILABLE"))};Vg.isAvailable=function(){return Dg()};Vg.prototype.Fc=function(){return"redirect"};function Wg(a){a.callback_parameter||(a.callback_parameter="callback");this.options=a;window.__firebase_auth_jsonp=window.__firebase_auth_jsonp||{}}
Wg.prototype.open=function(a,b,c){function d(){c&&(c(Sg("REQUEST_INTERRUPTED")),c=null)}function e(){setTimeout(function(){window.__firebase_auth_jsonp[f]=void 0;va(window.__firebase_auth_jsonp)&&(window.__firebase_auth_jsonp=void 0);try{var a=document.getElementById(f);a&&a.parentNode.removeChild(a)}catch(b){}},1);Ig(window,"beforeunload",d)}var f="fn"+(new Date).getTime()+Math.floor(99999*Math.random());b[this.options.callback_parameter]="__firebase_auth_jsonp."+f;a+=(/\?/.test(a)?"":"?")+Ib(b);
Hg(window,"beforeunload",d);window.__firebase_auth_jsonp[f]=function(a){c&&(c(null,a),c=null);e()};Xg(f,a,c)};
function Xg(a,b,c){setTimeout(function(){try{var d=document.createElement("script");d.type="text/javascript";d.id=a;d.async=!0;d.src=b;d.onerror=function(){var b=document.getElementById(a);null!==b&&b.parentNode.removeChild(b);c&&c(Sg("NETWORK_ERROR"))};var e=document.getElementsByTagName("head");(e&&0!=e.length?e[0]:document.documentElement).appendChild(d)}catch(f){c&&c(Sg("NETWORK_ERROR"))}},0)}Wg.isAvailable=function(){return"undefined"!==typeof document&&null!=document.createElement};
Wg.prototype.Fc=function(){return"json"};function Yg(a,b,c,d){ff.call(this,["auth_status"]);this.G=a;this.hf=b;this.ih=c;this.Pe=d;this.wc=new Bg(a,[bd,cd]);this.qb=null;this.We=!1;Zg(this)}ka(Yg,ff);h=Yg.prototype;h.Be=function(){return this.qb||null};function Zg(a){cd.get("redirect_request_id")&&$g(a);var b=a.wc.get();b&&b.token?(ah(a,b),a.hf(b.token,function(c,d){bh(a,c,d,!1,b.token,b)},function(b,d){ch(a,"resumeSession()",b,d)})):ah(a,null)}
function dh(a,b,c,d,e,f){"firebaseio-demo.com"===a.G.domain&&S("Firebase authentication is not supported on demo Firebases (*.firebaseio-demo.com). To secure your Firebase, create a production Firebase at https://www.firebase.com.");a.hf(b,function(f,k){bh(a,f,k,!0,b,c,d||{},e)},function(b,c){ch(a,"auth()",b,c,f)})}function eh(a,b){a.wc.clear();ah(a,null);a.ih(function(a,d){if("ok"===a)T(b,null);else{var e=(a||"error").toUpperCase(),f=e;d&&(f+=": "+d);f=Error(f);f.code=e;T(b,f)}})}
function bh(a,b,c,d,e,f,g,k){"ok"===b?(d&&(b=c.auth,f.auth=b,f.expires=c.expires,f.token=Ed(e)?e:"",c=null,b&&y(b,"uid")?c=z(b,"uid"):y(f,"uid")&&(c=z(f,"uid")),f.uid=c,c="custom",b&&y(b,"provider")?c=z(b,"provider"):y(f,"provider")&&(c=z(f,"provider")),f.provider=c,a.wc.clear(),Ed(e)&&(g=g||{},c=bd,"sessionOnly"===g.remember&&(c=cd),"none"!==g.remember&&a.wc.set(f,c)),ah(a,f)),T(k,null,f)):(a.wc.clear(),ah(a,null),f=a=(b||"error").toUpperCase(),c&&(f+=": "+c),f=Error(f),f.code=a,T(k,f))}
function ch(a,b,c,d,e){S(b+" was canceled: "+d);a.wc.clear();ah(a,null);a=Error(d);a.code=c.toUpperCase();T(e,a)}function fh(a,b,c,d,e){gh(a);c=new yg(d||{},{},c||{});hh(a,[Ug,Wg],"/auth/"+b,c,e)}
function ih(a,b,c,d){gh(a);var e=[Tg,Vg];c=Ag(c);var f=625;"anonymous"===b||"password"===b?setTimeout(function(){T(d,Sg("TRANSPORT_UNAVAILABLE"))},0):("github"===b&&(f=1025),c.he.window_features="menubar=yes,modal=yes,alwaysRaised=yeslocation=yes,resizable=yes,scrollbars=yes,status=yes,height=625,width="+f+",top="+("object"===typeof screen?.5*(screen.height-625):0)+",left="+("object"===typeof screen?.5*(screen.width-f):0),c.he.relay_url=Ng(a.G.lc),c.he.requestWithCredential=u(a.uc,a),hh(a,e,"/auth/"+
b,c,d))}function $g(a){var b=cd.get("redirect_request_id");if(b){var c=cd.get("redirect_client_options");cd.remove("redirect_request_id");cd.remove("redirect_client_options");var d=[Ug,Wg],b={requestId:b,requestKey:Kg(document.location.hash)},c=new yg(c,{},b);a.We=!0;Lg();hh(a,d,"/auth/session",c,function(){this.We=!1}.bind(a))}}h.ve=function(a,b){gh(this);var c=Ag(a);c.fb._method="POST";this.uc("/users",c,function(a,c){a?T(b,a):T(b,a,c)})};
h.Xe=function(a,b){var c=this;gh(this);var d="/users/"+encodeURIComponent(a.email),e=Ag(a);e.fb._method="DELETE";this.uc(d,e,function(a,d){!a&&d&&d.uid&&c.qb&&c.qb.uid&&c.qb.uid===d.uid&&eh(c);T(b,a)})};h.se=function(a,b){gh(this);var c="/users/"+encodeURIComponent(a.email)+"/password",d=Ag(a);d.fb._method="PUT";d.fb.password=a.newPassword;this.uc(c,d,function(a){T(b,a)})};
h.re=function(a,b){gh(this);var c="/users/"+encodeURIComponent(a.oldEmail)+"/email",d=Ag(a);d.fb._method="PUT";d.fb.email=a.newEmail;d.fb.password=a.password;this.uc(c,d,function(a){T(b,a)})};h.Ze=function(a,b){gh(this);var c="/users/"+encodeURIComponent(a.email)+"/password",d=Ag(a);d.fb._method="POST";this.uc(c,d,function(a){T(b,a)})};h.uc=function(a,b,c){jh(this,[Ug,Wg],a,b,c)};
function hh(a,b,c,d,e){jh(a,b,c,d,function(b,c){!b&&c&&c.token&&c.uid?dh(a,c.token,c,d.qd,function(a,b){a?T(e,a):T(e,null,b)}):T(e,b||Sg("UNKNOWN_ERROR"))})}
function jh(a,b,c,d,e){b=Na(b,function(a){return"function"===typeof a.isAvailable&&a.isAvailable()});0===b.length?setTimeout(function(){T(e,Sg("TRANSPORT_UNAVAILABLE"))},0):(b=new (b.shift())(d.he),d=Gb(d.fb),d.v="js-"+Eb,d.transport=b.Fc(),d.suppress_status_codes=!0,a=Mg()+"/"+a.G.lc+c,b.open(a,d,function(a,b){if(a)T(e,a);else if(b&&b.error){var c=Error(b.error.message);c.code=b.error.code;c.details=b.error.details;T(e,c)}else T(e,null,b)}))}
function ah(a,b){var c=null!==a.qb||null!==b;a.qb=b;c&&a.ie("auth_status",b);a.Pe(null!==b)}h.Ee=function(a){O("auth_status"===a,'initial event must be of type "auth_status"');return this.We?null:[this.qb]};function gh(a){var b=a.G;if("firebaseio.com"!==b.domain&&"firebaseio-demo.com"!==b.domain&&"auth.firebase.com"===xg)throw Error("This custom Firebase server ('"+a.G.domain+"') does not support delegated login.");};var gd="websocket",hd="long_polling";function kh(a){this.nc=a;this.Qd=[];this.Wb=0;this.te=-1;this.Jb=null}function lh(a,b,c){a.te=b;a.Jb=c;a.te<a.Wb&&(a.Jb(),a.Jb=null)}function mh(a,b,c){for(a.Qd[b]=c;a.Qd[a.Wb];){var d=a.Qd[a.Wb];delete a.Qd[a.Wb];for(var e=0;e<d.length;++e)if(d[e]){var f=a;gc(function(){f.nc(d[e])})}if(a.Wb===a.te){a.Jb&&(clearTimeout(a.Jb),a.Jb(),a.Jb=null);break}a.Wb++}};function nh(a,b,c,d){this.ue=a;this.f=pd(a);this.rb=this.sb=0;this.Xa=uc(b);this.Xf=c;this.Kc=!1;this.Fb=d;this.ld=function(a){return fd(b,hd,a)}}var oh,ph;
nh.prototype.open=function(a,b){this.mf=0;this.na=b;this.Ef=new kh(a);this.Db=!1;var c=this;this.ub=setTimeout(function(){c.f("Timed out trying to connect.");c.bb();c.ub=null},Math.floor(3E4));ud(function(){if(!c.Db){c.Wa=new qh(function(a,b,d,k,m){rh(c,arguments);if(c.Wa)if(c.ub&&(clearTimeout(c.ub),c.ub=null),c.Kc=!0,"start"==a)c.id=b,c.Mf=d;else if("close"===a)b?(c.Wa.$d=!1,lh(c.Ef,b,function(){c.bb()})):c.bb();else throw Error("Unrecognized command received: "+a);},function(a,b){rh(c,arguments);
mh(c.Ef,a,b)},function(){c.bb()},c.ld);var a={start:"t"};a.ser=Math.floor(1E8*Math.random());c.Wa.ke&&(a.cb=c.Wa.ke);a.v="5";c.Xf&&(a.s=c.Xf);c.Fb&&(a.ls=c.Fb);"undefined"!==typeof location&&location.href&&-1!==location.href.indexOf("firebaseio.com")&&(a.r="f");a=c.ld(a);c.f("Connecting via long-poll to "+a);sh(c.Wa,a,function(){})}})};
nh.prototype.start=function(){var a=this.Wa,b=this.Mf;a.Gg=this.id;a.Hg=b;for(a.oe=!0;th(a););a=this.id;b=this.Mf;this.kc=document.createElement("iframe");var c={dframe:"t"};c.id=a;c.pw=b;this.kc.src=this.ld(c);this.kc.style.display="none";document.body.appendChild(this.kc)};
nh.isAvailable=function(){return oh||!ph&&"undefined"!==typeof document&&null!=document.createElement&&!("object"===typeof window&&window.chrome&&window.chrome.extension&&!/^chrome/.test(window.location.href))&&!("object"===typeof Windows&&"object"===typeof Windows.kh)&&!0};h=nh.prototype;h.Hd=function(){};h.fd=function(){this.Db=!0;this.Wa&&(this.Wa.close(),this.Wa=null);this.kc&&(document.body.removeChild(this.kc),this.kc=null);this.ub&&(clearTimeout(this.ub),this.ub=null)};
h.bb=function(){this.Db||(this.f("Longpoll is closing itself"),this.fd(),this.na&&(this.na(this.Kc),this.na=null))};h.close=function(){this.Db||(this.f("Longpoll is being closed."),this.fd())};h.send=function(a){a=G(a);this.sb+=a.length;rc(this.Xa,"bytes_sent",a.length);a=Ob(a);a=nb(a,!0);a=yd(a,1840);for(var b=0;b<a.length;b++){var c=this.Wa;c.cd.push({Yg:this.mf,hh:a.length,of:a[b]});c.oe&&th(c);this.mf++}};function rh(a,b){var c=G(b).length;a.rb+=c;rc(a.Xa,"bytes_received",c)}
function qh(a,b,c,d){this.ld=d;this.lb=c;this.Te=new ug;this.cd=[];this.we=Math.floor(1E8*Math.random());this.$d=!0;this.ke=id();window["pLPCommand"+this.ke]=a;window["pRTLPCB"+this.ke]=b;a=document.createElement("iframe");a.style.display="none";if(document.body){document.body.appendChild(a);try{a.contentWindow.document||fc("No IE domain setting required")}catch(e){a.src="javascript:void((function(){document.open();document.domain='"+document.domain+"';document.close();})())"}}else throw"Document body has not initialized. Wait to initialize Firebase until after the document is ready.";
a.contentDocument?a.jb=a.contentDocument:a.contentWindow?a.jb=a.contentWindow.document:a.document&&(a.jb=a.document);this.Ga=a;a="";this.Ga.src&&"javascript:"===this.Ga.src.substr(0,11)&&(a='<script>document.domain="'+document.domain+'";\x3c/script>');a="<html><body>"+a+"</body></html>";try{this.Ga.jb.open(),this.Ga.jb.write(a),this.Ga.jb.close()}catch(f){fc("frame writing exception"),f.stack&&fc(f.stack),fc(f)}}
qh.prototype.close=function(){this.oe=!1;if(this.Ga){this.Ga.jb.body.innerHTML="";var a=this;setTimeout(function(){null!==a.Ga&&(document.body.removeChild(a.Ga),a.Ga=null)},Math.floor(0))}var b=this.lb;b&&(this.lb=null,b())};
function th(a){if(a.oe&&a.$d&&a.Te.count()<(0<a.cd.length?2:1)){a.we++;var b={};b.id=a.Gg;b.pw=a.Hg;b.ser=a.we;for(var b=a.ld(b),c="",d=0;0<a.cd.length;)if(1870>=a.cd[0].of.length+30+c.length){var e=a.cd.shift(),c=c+"&seg"+d+"="+e.Yg+"&ts"+d+"="+e.hh+"&d"+d+"="+e.of;d++}else break;uh(a,b+c,a.we);return!0}return!1}function uh(a,b,c){function d(){a.Te.remove(c);th(a)}a.Te.add(c,1);var e=setTimeout(d,Math.floor(25E3));sh(a,b,function(){clearTimeout(e);d()})}
function sh(a,b,c){setTimeout(function(){try{if(a.$d){var d=a.Ga.jb.createElement("script");d.type="text/javascript";d.async=!0;d.src=b;d.onload=d.onreadystatechange=function(){var a=d.readyState;a&&"loaded"!==a&&"complete"!==a||(d.onload=d.onreadystatechange=null,d.parentNode&&d.parentNode.removeChild(d),c())};d.onerror=function(){fc("Long-poll script failed to load: "+b);a.$d=!1;a.close()};a.Ga.jb.body.appendChild(d)}}catch(e){}},Math.floor(1))};var vh=null;"undefined"!==typeof MozWebSocket?vh=MozWebSocket:"undefined"!==typeof WebSocket&&(vh=WebSocket);function wh(a,b,c,d){this.ue=a;this.f=pd(this.ue);this.frames=this.Nc=null;this.rb=this.sb=this.ff=0;this.Xa=uc(b);a={v:"5"};"undefined"!==typeof location&&location.href&&-1!==location.href.indexOf("firebaseio.com")&&(a.r="f");c&&(a.s=c);d&&(a.ls=d);this.jf=fd(b,gd,a)}var xh;
wh.prototype.open=function(a,b){this.lb=b;this.Lg=a;this.f("Websocket connecting to "+this.jf);this.Kc=!1;bd.set("previous_websocket_failure",!0);try{this.La=new vh(this.jf)}catch(c){this.f("Error instantiating WebSocket.");var d=c.message||c.data;d&&this.f(d);this.bb();return}var e=this;this.La.onopen=function(){e.f("Websocket connected.");e.Kc=!0};this.La.onclose=function(){e.f("Websocket connection was disconnected.");e.La=null;e.bb()};this.La.onmessage=function(a){if(null!==e.La)if(a=a.data,e.rb+=
a.length,rc(e.Xa,"bytes_received",a.length),yh(e),null!==e.frames)zh(e,a);else{a:{O(null===e.frames,"We already have a frame buffer");if(6>=a.length){var b=Number(a);if(!isNaN(b)){e.ff=b;e.frames=[];a=null;break a}}e.ff=1;e.frames=[]}null!==a&&zh(e,a)}};this.La.onerror=function(a){e.f("WebSocket error.  Closing connection.");(a=a.message||a.data)&&e.f(a);e.bb()}};wh.prototype.start=function(){};
wh.isAvailable=function(){var a=!1;if("undefined"!==typeof navigator&&navigator.userAgent){var b=navigator.userAgent.match(/Android ([0-9]{0,}\.[0-9]{0,})/);b&&1<b.length&&4.4>parseFloat(b[1])&&(a=!0)}return!a&&null!==vh&&!xh};wh.responsesRequiredToBeHealthy=2;wh.healthyTimeout=3E4;h=wh.prototype;h.Hd=function(){bd.remove("previous_websocket_failure")};function zh(a,b){a.frames.push(b);if(a.frames.length==a.ff){var c=a.frames.join("");a.frames=null;c=Rb(c);a.Lg(c)}}
h.send=function(a){yh(this);a=G(a);this.sb+=a.length;rc(this.Xa,"bytes_sent",a.length);a=yd(a,16384);1<a.length&&Ah(this,String(a.length));for(var b=0;b<a.length;b++)Ah(this,a[b])};h.fd=function(){this.Db=!0;this.Nc&&(clearInterval(this.Nc),this.Nc=null);this.La&&(this.La.close(),this.La=null)};h.bb=function(){this.Db||(this.f("WebSocket is closing itself"),this.fd(),this.lb&&(this.lb(this.Kc),this.lb=null))};h.close=function(){this.Db||(this.f("WebSocket is being closed"),this.fd())};
function yh(a){clearInterval(a.Nc);a.Nc=setInterval(function(){a.La&&Ah(a,"0");yh(a)},Math.floor(45E3))}function Ah(a,b){try{a.La.send(b)}catch(c){a.f("Exception thrown from WebSocket.send():",c.message||c.data,"Closing connection."),setTimeout(u(a.bb,a),0)}};function Bh(a){Ch(this,a)}var Dh=[nh,wh];function Ch(a,b){var c=wh&&wh.isAvailable(),d=c&&!(bd.Af||!0===bd.get("previous_websocket_failure"));b.jh&&(c||S("wss:// URL used, but browser isn't known to support websockets.  Trying anyway."),d=!0);if(d)a.jd=[wh];else{var e=a.jd=[];zd(Dh,function(a,b){b&&b.isAvailable()&&e.push(b)})}}function Eh(a){if(0<a.jd.length)return a.jd[0];throw Error("No transports available");};function Fh(a,b,c,d,e,f,g){this.id=a;this.f=pd("c:"+this.id+":");this.nc=c;this.Zc=d;this.na=e;this.Re=f;this.G=b;this.Pd=[];this.kf=0;this.Wf=new Bh(b);this.N=0;this.Fb=g;this.f("Connection created");Gh(this)}
function Gh(a){var b=Eh(a.Wf);a.K=new b("c:"+a.id+":"+a.kf++,a.G,void 0,a.Fb);a.Ve=b.responsesRequiredToBeHealthy||0;var c=Hh(a,a.K),d=Ih(a,a.K);a.kd=a.K;a.ed=a.K;a.F=null;a.Eb=!1;setTimeout(function(){a.K&&a.K.open(c,d)},Math.floor(0));b=b.healthyTimeout||0;0<b&&(a.Bd=setTimeout(function(){a.Bd=null;a.Eb||(a.K&&102400<a.K.rb?(a.f("Connection exceeded healthy timeout but has received "+a.K.rb+" bytes.  Marking connection healthy."),a.Eb=!0,a.K.Hd()):a.K&&10240<a.K.sb?a.f("Connection exceeded healthy timeout but has sent "+
a.K.sb+" bytes.  Leaving connection alive."):(a.f("Closing unhealthy connection after timeout."),a.close()))},Math.floor(b)))}function Ih(a,b){return function(c){b===a.K?(a.K=null,c||0!==a.N?1===a.N&&a.f("Realtime connection lost."):(a.f("Realtime connection failed."),"s-"===a.G.ab.substr(0,2)&&(bd.remove("host:"+a.G.host),a.G.ab=a.G.host)),a.close()):b===a.F?(a.f("Secondary connection lost."),c=a.F,a.F=null,a.kd!==c&&a.ed!==c||a.close()):a.f("closing an old connection")}}
function Hh(a,b){return function(c){if(2!=a.N)if(b===a.ed){var d=wd("t",c);c=wd("d",c);if("c"==d){if(d=wd("t",c),"d"in c)if(c=c.d,"h"===d){var d=c.ts,e=c.v,f=c.h;a.Uf=c.s;ed(a.G,f);0==a.N&&(a.K.start(),Jh(a,a.K,d),"5"!==e&&S("Protocol version mismatch detected"),c=a.Wf,(c=1<c.jd.length?c.jd[1]:null)&&Kh(a,c))}else if("n"===d){a.f("recvd end transmission on primary");a.ed=a.F;for(c=0;c<a.Pd.length;++c)a.Ld(a.Pd[c]);a.Pd=[];Lh(a)}else"s"===d?(a.f("Connection shutdown command received. Shutting down..."),
a.Re&&(a.Re(c),a.Re=null),a.na=null,a.close()):"r"===d?(a.f("Reset packet received.  New host: "+c),ed(a.G,c),1===a.N?a.close():(Mh(a),Gh(a))):"e"===d?qd("Server Error: "+c):"o"===d?(a.f("got pong on primary."),Nh(a),Oh(a)):qd("Unknown control packet command: "+d)}else"d"==d&&a.Ld(c)}else if(b===a.F)if(d=wd("t",c),c=wd("d",c),"c"==d)"t"in c&&(c=c.t,"a"===c?Ph(a):"r"===c?(a.f("Got a reset on secondary, closing it"),a.F.close(),a.kd!==a.F&&a.ed!==a.F||a.close()):"o"===c&&(a.f("got pong on secondary."),
a.Tf--,Ph(a)));else if("d"==d)a.Pd.push(c);else throw Error("Unknown protocol layer: "+d);else a.f("message on old connection")}}Fh.prototype.Ia=function(a){Qh(this,{t:"d",d:a})};function Lh(a){a.kd===a.F&&a.ed===a.F&&(a.f("cleaning up and promoting a connection: "+a.F.ue),a.K=a.F,a.F=null)}
function Ph(a){0>=a.Tf?(a.f("Secondary connection is healthy."),a.Eb=!0,a.F.Hd(),a.F.start(),a.f("sending client ack on secondary"),a.F.send({t:"c",d:{t:"a",d:{}}}),a.f("Ending transmission on primary"),a.K.send({t:"c",d:{t:"n",d:{}}}),a.kd=a.F,Lh(a)):(a.f("sending ping on secondary."),a.F.send({t:"c",d:{t:"p",d:{}}}))}Fh.prototype.Ld=function(a){Nh(this);this.nc(a)};function Nh(a){a.Eb||(a.Ve--,0>=a.Ve&&(a.f("Primary connection is healthy."),a.Eb=!0,a.K.Hd()))}
function Kh(a,b){a.F=new b("c:"+a.id+":"+a.kf++,a.G,a.Uf);a.Tf=b.responsesRequiredToBeHealthy||0;a.F.open(Hh(a,a.F),Ih(a,a.F));setTimeout(function(){a.F&&(a.f("Timed out trying to upgrade."),a.F.close())},Math.floor(6E4))}function Jh(a,b,c){a.f("Realtime connection established.");a.K=b;a.N=1;a.Zc&&(a.Zc(c,a.Uf),a.Zc=null);0===a.Ve?(a.f("Primary connection is healthy."),a.Eb=!0):setTimeout(function(){Oh(a)},Math.floor(5E3))}
function Oh(a){a.Eb||1!==a.N||(a.f("sending ping on primary."),Qh(a,{t:"c",d:{t:"p",d:{}}}))}function Qh(a,b){if(1!==a.N)throw"Connection is not connected";a.kd.send(b)}Fh.prototype.close=function(){2!==this.N&&(this.f("Closing realtime connection."),this.N=2,Mh(this),this.na&&(this.na(),this.na=null))};function Mh(a){a.f("Shutting down all connections");a.K&&(a.K.close(),a.K=null);a.F&&(a.F.close(),a.F=null);a.Bd&&(clearTimeout(a.Bd),a.Bd=null)};function Rh(a,b,c,d){this.id=Sh++;this.f=pd("p:"+this.id+":");this.Bf=this.Ie=!1;this.ba={};this.sa=[];this.ad=0;this.Yc=[];this.qa=!1;this.eb=1E3;this.Id=3E5;this.Kb=b;this.Xc=c;this.Se=d;this.G=a;this.wb=this.Ca=this.Ma=this.Fb=this.$e=null;this.Sb=!1;this.Wd={};this.Xg=0;this.rf=!0;this.Oc=this.Ke=null;Th(this,0);kf.yb().Ib("visible",this.Og,this);-1===a.host.indexOf("fblocal")&&jf.yb().Ib("online",this.Mg,this)}var Sh=0,Uh=0;h=Rh.prototype;
h.Ia=function(a,b,c){var d=++this.Xg;a={r:d,a:a,b:b};this.f(G(a));O(this.qa,"sendRequest call when we're not connected not allowed.");this.Ma.Ia(a);c&&(this.Wd[d]=c)};h.Cf=function(a,b,c,d){var e=a.wa(),f=a.path.toString();this.f("Listen called for "+f+" "+e);this.ba[f]=this.ba[f]||{};O(Ie(a.n)||!He(a.n),"listen() called for non-default but complete query");O(!this.ba[f][e],"listen() called twice for same path/queryId.");a={I:d,Ad:b,Ug:a,tag:c};this.ba[f][e]=a;this.qa&&Vh(this,a)};
function Vh(a,b){var c=b.Ug,d=c.path.toString(),e=c.wa();a.f("Listen on "+d+" for "+e);var f={p:d};b.tag&&(f.q=Ge(c.n),f.t=b.tag);f.h=b.Ad();a.Ia("q",f,function(f){var k=f.d,m=f.s;if(k&&"object"===typeof k&&y(k,"w")){var l=z(k,"w");da(l)&&0<=La(l,"no_index")&&S("Using an unspecified index. Consider adding "+('".indexOn": "'+c.n.g.toString()+'"')+" at "+c.path.toString()+" to your security rules for better performance")}(a.ba[d]&&a.ba[d][e])===b&&(a.f("listen response",f),"ok"!==m&&Wh(a,d,e),b.I&&
b.I(m,k))})}h.O=function(a,b,c){this.Ca={rg:a,sf:!1,Dc:b,od:c};this.f("Authenticating using credential: "+a);Xh(this);(b=40==a.length)||(a=Cd(a).Ec,b="object"===typeof a&&!0===z(a,"admin"));b&&(this.f("Admin auth credential detected.  Reducing max reconnect time."),this.Id=3E4)};h.je=function(a){this.Ca=null;this.qa&&this.Ia("unauth",{},function(b){a(b.s,b.d)})};
function Xh(a){var b=a.Ca;a.qa&&b&&a.Ia("auth",{cred:b.rg},function(c){var d=c.s;c=c.d||"error";"ok"!==d&&a.Ca===b&&(a.Ca=null);b.sf?"ok"!==d&&b.od&&b.od(d,c):(b.sf=!0,b.Dc&&b.Dc(d,c))})}h.$f=function(a,b){var c=a.path.toString(),d=a.wa();this.f("Unlisten called for "+c+" "+d);O(Ie(a.n)||!He(a.n),"unlisten() called for non-default but complete query");if(Wh(this,c,d)&&this.qa){var e=Ge(a.n);this.f("Unlisten on "+c+" for "+d);c={p:c};b&&(c.q=e,c.t=b);this.Ia("n",c)}};
h.Qe=function(a,b,c){this.qa?Yh(this,"o",a,b,c):this.Yc.push({bd:a,action:"o",data:b,I:c})};h.Gf=function(a,b,c){this.qa?Yh(this,"om",a,b,c):this.Yc.push({bd:a,action:"om",data:b,I:c})};h.Md=function(a,b){this.qa?Yh(this,"oc",a,null,b):this.Yc.push({bd:a,action:"oc",data:null,I:b})};function Yh(a,b,c,d,e){c={p:c,d:d};a.f("onDisconnect "+b,c);a.Ia(b,c,function(a){e&&setTimeout(function(){e(a.s,a.d)},Math.floor(0))})}h.put=function(a,b,c,d){Zh(this,"p",a,b,c,d)};
h.Df=function(a,b,c,d){Zh(this,"m",a,b,c,d)};function Zh(a,b,c,d,e,f){d={p:c,d:d};p(f)&&(d.h=f);a.sa.push({action:b,Pf:d,I:e});a.ad++;b=a.sa.length-1;a.qa?$h(a,b):a.f("Buffering put: "+c)}function $h(a,b){var c=a.sa[b].action,d=a.sa[b].Pf,e=a.sa[b].I;a.sa[b].Vg=a.qa;a.Ia(c,d,function(d){a.f(c+" response",d);delete a.sa[b];a.ad--;0===a.ad&&(a.sa=[]);e&&e(d.s,d.d)})}
h.Ye=function(a){this.qa&&(a={c:a},this.f("reportStats",a),this.Ia("s",a,function(a){"ok"!==a.s&&this.f("reportStats","Error sending stats: "+a.d)}))};
h.Ld=function(a){if("r"in a){this.f("from server: "+G(a));var b=a.r,c=this.Wd[b];c&&(delete this.Wd[b],c(a.b))}else{if("error"in a)throw"A server-side error has occurred: "+a.error;"a"in a&&(b=a.a,c=a.b,this.f("handleServerMessage",b,c),"d"===b?this.Kb(c.p,c.d,!1,c.t):"m"===b?this.Kb(c.p,c.d,!0,c.t):"c"===b?ai(this,c.p,c.q):"ac"===b?(a=c.s,b=c.d,c=this.Ca,this.Ca=null,c&&c.od&&c.od(a,b)):"sd"===b?this.$e?this.$e(c):"msg"in c&&"undefined"!==typeof console&&console.log("FIREBASE: "+c.msg.replace("\n",
"\nFIREBASE: ")):qd("Unrecognized action received from server: "+G(b)+"\nAre you using the latest client?"))}};h.Zc=function(a,b){this.f("connection ready");this.qa=!0;this.Oc=(new Date).getTime();this.Se({serverTimeOffset:a-(new Date).getTime()});this.Fb=b;if(this.rf){var c={};c["sdk.js."+Eb.replace(/\./g,"-")]=1;Dg()?c["framework.cordova"]=1:"object"===typeof navigator&&"ReactNative"===navigator.product&&(c["framework.reactnative"]=1);this.Ye(c)}bi(this);this.rf=!1;this.Xc(!0)};
function Th(a,b){O(!a.Ma,"Scheduling a connect when we're already connected/ing?");a.wb&&clearTimeout(a.wb);a.wb=setTimeout(function(){a.wb=null;ci(a)},Math.floor(b))}h.Og=function(a){a&&!this.Sb&&this.eb===this.Id&&(this.f("Window became visible.  Reducing delay."),this.eb=1E3,this.Ma||Th(this,0));this.Sb=a};h.Mg=function(a){a?(this.f("Browser went online."),this.eb=1E3,this.Ma||Th(this,0)):(this.f("Browser went offline.  Killing connection."),this.Ma&&this.Ma.close())};
h.If=function(){this.f("data client disconnected");this.qa=!1;this.Ma=null;for(var a=0;a<this.sa.length;a++){var b=this.sa[a];b&&"h"in b.Pf&&b.Vg&&(b.I&&b.I("disconnect"),delete this.sa[a],this.ad--)}0===this.ad&&(this.sa=[]);this.Wd={};di(this)&&(this.Sb?this.Oc&&(3E4<(new Date).getTime()-this.Oc&&(this.eb=1E3),this.Oc=null):(this.f("Window isn't visible.  Delaying reconnect."),this.eb=this.Id,this.Ke=(new Date).getTime()),a=Math.max(0,this.eb-((new Date).getTime()-this.Ke)),a*=Math.random(),this.f("Trying to reconnect in "+
a+"ms"),Th(this,a),this.eb=Math.min(this.Id,1.3*this.eb));this.Xc(!1)};function ci(a){if(di(a)){a.f("Making a connection attempt");a.Ke=(new Date).getTime();a.Oc=null;var b=u(a.Ld,a),c=u(a.Zc,a),d=u(a.If,a),e=a.id+":"+Uh++;a.Ma=new Fh(e,a.G,b,c,d,function(b){S(b+" ("+a.G.toString()+")");a.Bf=!0},a.Fb)}}h.Cb=function(){this.Ie=!0;this.Ma?this.Ma.close():(this.wb&&(clearTimeout(this.wb),this.wb=null),this.qa&&this.If())};h.vc=function(){this.Ie=!1;this.eb=1E3;this.Ma||Th(this,0)};
function ai(a,b,c){c=c?Oa(c,function(a){return xd(a)}).join("$"):"default";(a=Wh(a,b,c))&&a.I&&a.I("permission_denied")}function Wh(a,b,c){b=(new P(b)).toString();var d;p(a.ba[b])?(d=a.ba[b][c],delete a.ba[b][c],0===oa(a.ba[b])&&delete a.ba[b]):d=void 0;return d}function bi(a){Xh(a);v(a.ba,function(b){v(b,function(b){Vh(a,b)})});for(var b=0;b<a.sa.length;b++)a.sa[b]&&$h(a,b);for(;a.Yc.length;)b=a.Yc.shift(),Yh(a,b.action,b.bd,b.data,b.I)}function di(a){var b;b=jf.yb().oc;return!a.Bf&&!a.Ie&&b};var U={zg:function(){oh=xh=!0}};U.forceLongPolling=U.zg;U.Ag=function(){ph=!0};U.forceWebSockets=U.Ag;U.Eg=function(){return wh.isAvailable()};U.isWebSocketsAvailable=U.Eg;U.ah=function(a,b){a.k.Va.$e=b};U.setSecurityDebugCallback=U.ah;U.bf=function(a,b){a.k.bf(b)};U.stats=U.bf;U.cf=function(a,b){a.k.cf(b)};U.statsIncrementCounter=U.cf;U.ud=function(a){return a.k.ud};U.dataUpdateCount=U.ud;U.Dg=function(a,b){a.k.He=b};U.interceptServerData=U.Dg;U.Kg=function(a){new Og(a)};U.onPopupOpen=U.Kg;
U.Zg=function(a){xg=a};U.setAuthenticationServer=U.Zg;function ei(a,b){this.committed=a;this.snapshot=b};function V(a,b){this.dd=a;this.ta=b}V.prototype.cancel=function(a){D("Firebase.onDisconnect().cancel",0,1,arguments.length);F("Firebase.onDisconnect().cancel",1,a,!0);var b=new B;this.dd.Md(this.ta,C(b,a));return b.D};V.prototype.cancel=V.prototype.cancel;V.prototype.remove=function(a){D("Firebase.onDisconnect().remove",0,1,arguments.length);og("Firebase.onDisconnect().remove",this.ta);F("Firebase.onDisconnect().remove",1,a,!0);var b=new B;fi(this.dd,this.ta,null,C(b,a));return b.D};
V.prototype.remove=V.prototype.remove;V.prototype.set=function(a,b){D("Firebase.onDisconnect().set",1,2,arguments.length);og("Firebase.onDisconnect().set",this.ta);gg("Firebase.onDisconnect().set",a,this.ta,!1);F("Firebase.onDisconnect().set",2,b,!0);var c=new B;fi(this.dd,this.ta,a,C(c,b));return c.D};V.prototype.set=V.prototype.set;
V.prototype.Ob=function(a,b,c){D("Firebase.onDisconnect().setWithPriority",2,3,arguments.length);og("Firebase.onDisconnect().setWithPriority",this.ta);gg("Firebase.onDisconnect().setWithPriority",a,this.ta,!1);kg("Firebase.onDisconnect().setWithPriority",2,b);F("Firebase.onDisconnect().setWithPriority",3,c,!0);var d=new B;gi(this.dd,this.ta,a,b,C(d,c));return d.D};V.prototype.setWithPriority=V.prototype.Ob;
V.prototype.update=function(a,b){D("Firebase.onDisconnect().update",1,2,arguments.length);og("Firebase.onDisconnect().update",this.ta);if(da(a)){for(var c={},d=0;d<a.length;++d)c[""+d]=a[d];a=c;S("Passing an Array to Firebase.onDisconnect().update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.")}jg("Firebase.onDisconnect().update",a,this.ta);F("Firebase.onDisconnect().update",2,b,!0);
c=new B;hi(this.dd,this.ta,a,C(c,b));return c.D};V.prototype.update=V.prototype.update;function W(a,b,c){this.A=a;this.Y=b;this.g=c}W.prototype.J=function(){D("Firebase.DataSnapshot.val",0,0,arguments.length);return this.A.J()};W.prototype.val=W.prototype.J;W.prototype.qf=function(){D("Firebase.DataSnapshot.exportVal",0,0,arguments.length);return this.A.J(!0)};W.prototype.exportVal=W.prototype.qf;W.prototype.xg=function(){D("Firebase.DataSnapshot.exists",0,0,arguments.length);return!this.A.e()};W.prototype.exists=W.prototype.xg;
W.prototype.o=function(a){D("Firebase.DataSnapshot.child",0,1,arguments.length);fa(a)&&(a=String(a));ng("Firebase.DataSnapshot.child",a);var b=new P(a),c=this.Y.o(b);return new W(this.A.S(b),c,R)};W.prototype.child=W.prototype.o;W.prototype.Fa=function(a){D("Firebase.DataSnapshot.hasChild",1,1,arguments.length);ng("Firebase.DataSnapshot.hasChild",a);var b=new P(a);return!this.A.S(b).e()};W.prototype.hasChild=W.prototype.Fa;
W.prototype.C=function(){D("Firebase.DataSnapshot.getPriority",0,0,arguments.length);return this.A.C().J()};W.prototype.getPriority=W.prototype.C;W.prototype.forEach=function(a){D("Firebase.DataSnapshot.forEach",1,1,arguments.length);F("Firebase.DataSnapshot.forEach",1,a,!1);if(this.A.L())return!1;var b=this;return!!this.A.R(this.g,function(c,d){return a(new W(d,b.Y.o(c),R))})};W.prototype.forEach=W.prototype.forEach;
W.prototype.zd=function(){D("Firebase.DataSnapshot.hasChildren",0,0,arguments.length);return this.A.L()?!1:!this.A.e()};W.prototype.hasChildren=W.prototype.zd;W.prototype.name=function(){S("Firebase.DataSnapshot.name() being deprecated. Please use Firebase.DataSnapshot.key() instead.");D("Firebase.DataSnapshot.name",0,0,arguments.length);return this.key()};W.prototype.name=W.prototype.name;W.prototype.key=function(){D("Firebase.DataSnapshot.key",0,0,arguments.length);return this.Y.key()};
W.prototype.key=W.prototype.key;W.prototype.Hb=function(){D("Firebase.DataSnapshot.numChildren",0,0,arguments.length);return this.A.Hb()};W.prototype.numChildren=W.prototype.Hb;W.prototype.Mb=function(){D("Firebase.DataSnapshot.ref",0,0,arguments.length);return this.Y};W.prototype.ref=W.prototype.Mb;function ii(a,b,c){this.Vb=a;this.tb=b;this.vb=c||null}h=ii.prototype;h.Qf=function(a){return"value"===a};h.createEvent=function(a,b){var c=b.n.g;return new jc("value",this,new W(a.Na,b.Mb(),c))};h.Zb=function(a){var b=this.vb;if("cancel"===a.De()){O(this.tb,"Raising a cancel event on a listener with no cancel callback");var c=this.tb;return function(){c.call(b,a.error)}}var d=this.Vb;return function(){d.call(b,a.be)}};h.lf=function(a,b){return this.tb?new kc(this,a,b):null};
h.matches=function(a){return a instanceof ii?a.Vb&&this.Vb?a.Vb===this.Vb&&a.vb===this.vb:!0:!1};h.yf=function(){return null!==this.Vb};function ji(a,b,c){this.ja=a;this.tb=b;this.vb=c}h=ji.prototype;h.Qf=function(a){a="children_added"===a?"child_added":a;return("children_removed"===a?"child_removed":a)in this.ja};h.lf=function(a,b){return this.tb?new kc(this,a,b):null};
h.createEvent=function(a,b){O(null!=a.Za,"Child events should have a childName.");var c=b.Mb().o(a.Za);return new jc(a.type,this,new W(a.Na,c,b.n.g),a.Td)};h.Zb=function(a){var b=this.vb;if("cancel"===a.De()){O(this.tb,"Raising a cancel event on a listener with no cancel callback");var c=this.tb;return function(){c.call(b,a.error)}}var d=this.ja[a.wd];return function(){d.call(b,a.be,a.Td)}};
h.matches=function(a){if(a instanceof ji){if(!this.ja||!a.ja)return!0;if(this.vb===a.vb){var b=oa(a.ja);if(b===oa(this.ja)){if(1===b){var b=pa(a.ja),c=pa(this.ja);return c===b&&(!a.ja[b]||!this.ja[c]||a.ja[b]===this.ja[c])}return na(this.ja,function(b,c){return a.ja[c]===b})}}}return!1};h.yf=function(){return null!==this.ja};function ki(){this.za={}}h=ki.prototype;h.e=function(){return va(this.za)};h.gb=function(a,b,c){var d=a.source.Lb;if(null!==d)return d=z(this.za,d),O(null!=d,"SyncTree gave us an op for an invalid query."),d.gb(a,b,c);var e=[];v(this.za,function(d){e=e.concat(d.gb(a,b,c))});return e};h.Tb=function(a,b,c,d,e){var f=a.wa(),g=z(this.za,f);if(!g){var g=c.Aa(e?d:null),k=!1;g?k=!0:(g=d instanceof fe?c.Cc(d):H,k=!1);g=new Ye(a,new je(new Xb(g,k,!1),new Xb(d,e,!1)));this.za[f]=g}g.Tb(b);return af(g,b)};
h.nb=function(a,b,c){var d=a.wa(),e=[],f=[],g=null!=li(this);if("default"===d){var k=this;v(this.za,function(a,d){f=f.concat(a.nb(b,c));a.e()&&(delete k.za[d],He(a.Y.n)||e.push(a.Y))})}else{var m=z(this.za,d);m&&(f=f.concat(m.nb(b,c)),m.e()&&(delete this.za[d],He(m.Y.n)||e.push(m.Y)))}g&&null==li(this)&&e.push(new X(a.k,a.path));return{Wg:e,vg:f}};function mi(a){return Na(qa(a.za),function(a){return!He(a.Y.n)})}h.kb=function(a){var b=null;v(this.za,function(c){b=b||c.kb(a)});return b};
function ni(a,b){if(He(b.n))return li(a);var c=b.wa();return z(a.za,c)}function li(a){return ua(a.za,function(a){return He(a.Y.n)})||null};function oi(a){this.va=qe;this.mb=new Pf;this.df={};this.qc={};this.Qc=a}function pi(a,b,c,d,e){var f=a.mb,g=e;O(d>f.Pc,"Stacking an older write on top of newer ones");p(g)||(g=!0);f.pa.push({path:b,Ja:c,md:d,visible:g});g&&(f.V=Jf(f.V,b,c));f.Pc=d;return e?qi(a,new Ac(Ef,b,c)):[]}function ri(a,b,c,d){var e=a.mb;O(d>e.Pc,"Stacking an older merge on top of newer ones");e.pa.push({path:b,children:c,md:d,visible:!0});e.V=Kf(e.V,b,c);e.Pc=d;c=sf(c);return qi(a,new bf(Ef,b,c))}
function si(a,b,c){c=c||!1;var d=Qf(a.mb,b);if(a.mb.Ud(b)){var e=qe;null!=d.Ja?e=e.set(M,!0):Fb(d.children,function(a,b){e=e.set(new P(a),b)});return qi(a,new Df(d.path,e,c))}return[]}function ti(a,b,c){c=sf(c);return qi(a,new bf(Gf,b,c))}function ui(a,b,c,d){d=vi(a,d);if(null!=d){var e=wi(d);d=e.path;e=e.Lb;b=lf(d,b);c=new Ac(new Ff(!1,!0,e,!0),b,c);return xi(a,d,c)}return[]}
function yi(a,b,c,d){if(d=vi(a,d)){var e=wi(d);d=e.path;e=e.Lb;b=lf(d,b);c=sf(c);c=new bf(new Ff(!1,!0,e,!0),b,c);return xi(a,d,c)}return[]}
oi.prototype.Tb=function(a,b){var c=a.path,d=null,e=!1;zf(this.va,c,function(a,b){var f=lf(a,c);d=d||b.kb(f);e=e||null!=li(b)});var f=this.va.get(c);f?(e=e||null!=li(f),d=d||f.kb(M)):(f=new ki,this.va=this.va.set(c,f));var g;null!=d?g=!0:(g=!1,d=H,Cf(this.va.subtree(c),function(a,b){var c=b.kb(M);c&&(d=d.W(a,c))}));var k=null!=ni(f,a);if(!k&&!He(a.n)){var m=zi(a);O(!(m in this.qc),"View does not exist, but we have a tag");var l=Ai++;this.qc[m]=l;this.df["_"+l]=m}g=f.Tb(a,b,new Uf(c,this.mb),d,g);
k||e||(f=ni(f,a),g=g.concat(Bi(this,a,f)));return g};
oi.prototype.nb=function(a,b,c){var d=a.path,e=this.va.get(d),f=[];if(e&&("default"===a.wa()||null!=ni(e,a))){f=e.nb(a,b,c);e.e()&&(this.va=this.va.remove(d));e=f.Wg;f=f.vg;b=-1!==Sa(e,function(a){return He(a.n)});var g=xf(this.va,d,function(a,b){return null!=li(b)});if(b&&!g&&(d=this.va.subtree(d),!d.e()))for(var d=Ci(d),k=0;k<d.length;++k){var m=d[k],l=m.Y,m=Di(this,m);this.Qc.af(Ei(l),Fi(this,l),m.Ad,m.I)}if(!g&&0<e.length&&!c)if(b)this.Qc.de(Ei(a),null);else{var t=this;Ma(e,function(a){a.wa();
var b=t.qc[zi(a)];t.Qc.de(Ei(a),b)})}Gi(this,e)}return f};oi.prototype.Aa=function(a,b){var c=this.mb,d=xf(this.va,a,function(b,c){var d=lf(b,a);if(d=c.kb(d))return d});return c.Aa(a,d,b,!0)};function Ci(a){return vf(a,function(a,c,d){if(c&&null!=li(c))return[li(c)];var e=[];c&&(e=mi(c));v(d,function(a){e=e.concat(a)});return e})}function Gi(a,b){for(var c=0;c<b.length;++c){var d=b[c];if(!He(d.n)){var d=zi(d),e=a.qc[d];delete a.qc[d];delete a.df["_"+e]}}}
function Ei(a){return He(a.n)&&!Ie(a.n)?a.Mb():a}function Bi(a,b,c){var d=b.path,e=Fi(a,b);c=Di(a,c);b=a.Qc.af(Ei(b),e,c.Ad,c.I);d=a.va.subtree(d);if(e)O(null==li(d.value),"If we're adding a query, it shouldn't be shadowed");else for(e=vf(d,function(a,b,c){if(!a.e()&&b&&null!=li(b))return[Ze(li(b))];var d=[];b&&(d=d.concat(Oa(mi(b),function(a){return a.Y})));v(c,function(a){d=d.concat(a)});return d}),d=0;d<e.length;++d)c=e[d],a.Qc.de(Ei(c),Fi(a,c));return b}
function Di(a,b){var c=b.Y,d=Fi(a,c);return{Ad:function(){return(b.w()||H).hash()},I:function(b){if("ok"===b){if(d){var f=c.path;if(b=vi(a,d)){var g=wi(b);b=g.path;g=g.Lb;f=lf(b,f);f=new Cc(new Ff(!1,!0,g,!0),f);b=xi(a,b,f)}else b=[]}else b=qi(a,new Cc(Gf,c.path));return b}f="Unknown Error";"too_big"===b?f="The data requested exceeds the maximum size that can be accessed with a single request.":"permission_denied"==b?f="Client doesn't have permission to access the desired data.":"unavailable"==b&&
(f="The service is unavailable");f=Error(b+" at "+c.path.toString()+": "+f);f.code=b.toUpperCase();return a.nb(c,null,f)}}}function zi(a){return a.path.toString()+"$"+a.wa()}function wi(a){var b=a.indexOf("$");O(-1!==b&&b<a.length-1,"Bad queryKey.");return{Lb:a.substr(b+1),path:new P(a.substr(0,b))}}function vi(a,b){var c=a.df,d="_"+b;return d in c?c[d]:void 0}function Fi(a,b){var c=zi(b);return z(a.qc,c)}var Ai=1;
function xi(a,b,c){var d=a.va.get(b);O(d,"Missing sync point for query tag that we're tracking");return d.gb(c,new Uf(b,a.mb),null)}function qi(a,b){return Hi(a,b,a.va,null,new Uf(M,a.mb))}function Hi(a,b,c,d,e){if(b.path.e())return Ii(a,b,c,d,e);var f=c.get(M);null==d&&null!=f&&(d=f.kb(M));var g=[],k=K(b.path),m=b.$c(k);if((c=c.children.get(k))&&m)var l=d?d.T(k):null,k=e.o(k),g=g.concat(Hi(a,m,c,l,k));f&&(g=g.concat(f.gb(b,e,d)));return g}
function Ii(a,b,c,d,e){var f=c.get(M);null==d&&null!=f&&(d=f.kb(M));var g=[];c.children.ka(function(c,f){var l=d?d.T(c):null,t=e.o(c),A=b.$c(c);A&&(g=g.concat(Ii(a,A,f,l,t)))});f&&(g=g.concat(f.gb(b,e,d)));return g};function Ji(a,b){this.G=a;this.Xa=uc(a);this.hd=null;this.fa=new Zb;this.Kd=1;this.Va=null;b||0<=("object"===typeof window&&window.navigator&&window.navigator.userAgent||"").search(/googlebot|google webmaster tools|bingbot|yahoo! slurp|baiduspider|yandexbot|duckduckbot/i)?(this.da=new cf(this.G,u(this.Kb,this)),setTimeout(u(this.Xc,this,!0),0)):this.da=this.Va=new Rh(this.G,u(this.Kb,this),u(this.Xc,this),u(this.Se,this));this.eh=vc(a,u(function(){return new pc(this.Xa,this.da)},this));this.yc=new Wf;
this.Ge=new Sb;var c=this;this.Fd=new oi({af:function(a,b,f,g){b=[];f=c.Ge.j(a.path);f.e()||(b=qi(c.Fd,new Ac(Gf,a.path,f)),setTimeout(function(){g("ok")},0));return b},de:aa});Ki(this,"connected",!1);this.na=new Vc;this.O=new Yg(a,u(this.da.O,this.da),u(this.da.je,this.da),u(this.Pe,this));this.ud=0;this.He=null;this.M=new oi({af:function(a,b,f,g){c.da.Cf(a,f,b,function(b,e){var f=g(b,e);dc(c.fa,a.path,f)});return[]},de:function(a,b){c.da.$f(a,b)}})}h=Ji.prototype;
h.toString=function(){return(this.G.ob?"https://":"http://")+this.G.host};h.name=function(){return this.G.lc};function Li(a){a=a.Ge.j(new P(".info/serverTimeOffset")).J()||0;return(new Date).getTime()+a}function Mi(a){a=a={timestamp:Li(a)};a.timestamp=a.timestamp||(new Date).getTime();return a}
h.Kb=function(a,b,c,d){this.ud++;var e=new P(a);b=this.He?this.He(a,b):b;a=[];d?c?(b=ma(b,function(a){return Q(a)}),a=yi(this.M,e,b,d)):(b=Q(b),a=ui(this.M,e,b,d)):c?(d=ma(b,function(a){return Q(a)}),a=ti(this.M,e,d)):(d=Q(b),a=qi(this.M,new Ac(Gf,e,d)));d=e;0<a.length&&(d=Ni(this,e));dc(this.fa,d,a)};h.Xc=function(a){Ki(this,"connected",a);!1===a&&Oi(this)};h.Se=function(a){var b=this;zd(a,function(a,d){Ki(b,d,a)})};h.Pe=function(a){Ki(this,"authenticated",a)};
function Ki(a,b,c){b=new P("/.info/"+b);c=Q(c);var d=a.Ge;d.Zd=d.Zd.H(b,c);c=qi(a.Fd,new Ac(Gf,b,c));dc(a.fa,b,c)}h.Ob=function(a,b,c,d){this.f("set",{path:a.toString(),value:b,nh:c});var e=Mi(this);b=Q(b,c);var e=Xc(b,e),f=this.Kd++,e=pi(this.M,a,e,f,!0);$b(this.fa,e);var g=this;this.da.put(a.toString(),b.J(!0),function(b,c){var e="ok"===b;e||S("set at "+a+" failed: "+b);e=si(g.M,f,!e);dc(g.fa,a,e);Pi(d,b,c)});e=Qi(this,a);Ni(this,e);dc(this.fa,e,[])};
h.update=function(a,b,c){this.f("update",{path:a.toString(),value:b});var d=!0,e=Mi(this),f={};v(b,function(a,b){d=!1;var c=Q(a);f[b]=Xc(c,e)});if(d)fc("update() called with empty data.  Don't do anything."),Pi(c,"ok");else{var g=this.Kd++,k=ri(this.M,a,f,g);$b(this.fa,k);var m=this;this.da.Df(a.toString(),b,function(b,d){var e="ok"===b;e||S("update at "+a+" failed: "+b);var e=si(m.M,g,!e),f=a;0<e.length&&(f=Ni(m,a));dc(m.fa,f,e);Pi(c,b,d)});b=Qi(this,a);Ni(this,b);dc(this.fa,a,[])}};
function Oi(a){a.f("onDisconnectEvents");var b=Mi(a),c=[];Wc(Uc(a.na,b),M,function(b,e){c=c.concat(qi(a.M,new Ac(Gf,b,e)));var f=Qi(a,b);Ni(a,f)});a.na=new Vc;dc(a.fa,M,c)}h.Md=function(a,b){var c=this;this.da.Md(a.toString(),function(d,e){"ok"===d&&wg(c.na,a);Pi(b,d,e)})};function fi(a,b,c,d){var e=Q(c);a.da.Qe(b.toString(),e.J(!0),function(c,g){"ok"===c&&a.na.rc(b,e);Pi(d,c,g)})}function gi(a,b,c,d,e){var f=Q(c,d);a.da.Qe(b.toString(),f.J(!0),function(c,d){"ok"===c&&a.na.rc(b,f);Pi(e,c,d)})}
function hi(a,b,c,d){var e=!0,f;for(f in c)e=!1;e?(fc("onDisconnect().update() called with empty data.  Don't do anything."),Pi(d,"ok")):a.da.Gf(b.toString(),c,function(e,f){if("ok"===e)for(var m in c){var l=Q(c[m]);a.na.rc(b.o(m),l)}Pi(d,e,f)})}function Ri(a,b,c){c=".info"===K(b.path)?a.Fd.Tb(b,c):a.M.Tb(b,c);bc(a.fa,b.path,c)}h.Cb=function(){this.Va&&this.Va.Cb()};h.vc=function(){this.Va&&this.Va.vc()};
h.bf=function(a){if("undefined"!==typeof console){a?(this.hd||(this.hd=new oc(this.Xa)),a=this.hd.get()):a=this.Xa.get();var b=Pa(ra(a),function(a,b){return Math.max(b.length,a)},0),c;for(c in a){for(var d=a[c],e=c.length;e<b+2;e++)c+=" ";console.log(c+d)}}};h.cf=function(a){rc(this.Xa,a);this.eh.Vf[a]=!0};h.f=function(a){var b="";this.Va&&(b=this.Va.id+":");fc(b,arguments)};
function Pi(a,b,c){a&&gc(function(){if("ok"==b)a(null);else{var d=(b||"error").toUpperCase(),e=d;c&&(e+=": "+c);e=Error(e);e.code=d;a(e)}})};function Si(a,b,c,d,e){function f(){}a.f("transaction on "+b);var g=new X(a,b);g.Ib("value",f);c={path:b,update:c,I:d,status:null,Lf:id(),gf:e,Sf:0,le:function(){g.mc("value",f)},ne:null,Da:null,rd:null,sd:null,td:null};d=a.M.Aa(b,void 0)||H;c.rd=d;d=c.update(d.J());if(p(d)){hg("transaction failed: Data returned ",d,c.path);c.status=1;e=Xf(a.yc,b);var k=e.Ea()||[];k.push(c);Yf(e,k);"object"===typeof d&&null!==d&&y(d,".priority")?(k=z(d,".priority"),O(fg(k),"Invalid priority returned by transaction. Priority must be a valid string, finite number, server value, or null.")):
k=(a.M.Aa(b)||H).C().J();e=Mi(a);d=Q(d,k);e=Xc(d,e);c.sd=d;c.td=e;c.Da=a.Kd++;c=pi(a.M,b,e,c.Da,c.gf);dc(a.fa,b,c);Ti(a)}else c.le(),c.sd=null,c.td=null,c.I&&(a=new W(c.rd,new X(a,c.path),R),c.I(null,!1,a))}function Ti(a,b){var c=b||a.yc;b||Ui(a,c);if(null!==c.Ea()){var d=Vi(a,c);O(0<d.length,"Sending zero length transaction queue");Qa(d,function(a){return 1===a.status})&&Wi(a,c.path(),d)}else c.zd()&&c.R(function(b){Ti(a,b)})}
function Wi(a,b,c){for(var d=Oa(c,function(a){return a.Da}),e=a.M.Aa(b,d)||H,d=e,e=e.hash(),f=0;f<c.length;f++){var g=c[f];O(1===g.status,"tryToSendTransactionQueue_: items in queue should all be run.");g.status=2;g.Sf++;var k=lf(b,g.path),d=d.H(k,g.sd)}d=d.J(!0);a.da.put(b.toString(),d,function(d){a.f("transaction put response",{path:b.toString(),status:d});var e=[];if("ok"===d){d=[];for(f=0;f<c.length;f++){c[f].status=3;e=e.concat(si(a.M,c[f].Da));if(c[f].I){var g=c[f].td,k=new X(a,c[f].path);d.push(u(c[f].I,
null,null,!0,new W(g,k,R)))}c[f].le()}Ui(a,Xf(a.yc,b));Ti(a);dc(a.fa,b,e);for(f=0;f<d.length;f++)gc(d[f])}else{if("datastale"===d)for(f=0;f<c.length;f++)c[f].status=4===c[f].status?5:1;else for(S("transaction at "+b.toString()+" failed: "+d),f=0;f<c.length;f++)c[f].status=5,c[f].ne=d;Ni(a,b)}},e)}function Ni(a,b){var c=Xi(a,b),d=c.path(),c=Vi(a,c);Yi(a,c,d);return d}
function Yi(a,b,c){if(0!==b.length){for(var d=[],e=[],f=Na(b,function(a){return 1===a.status}),f=Oa(f,function(a){return a.Da}),g=0;g<b.length;g++){var k=b[g],m=lf(c,k.path),l=!1,t;O(null!==m,"rerunTransactionsUnderNode_: relativePath should not be null.");if(5===k.status)l=!0,t=k.ne,e=e.concat(si(a.M,k.Da,!0));else if(1===k.status)if(25<=k.Sf)l=!0,t="maxretry",e=e.concat(si(a.M,k.Da,!0));else{var A=a.M.Aa(k.path,f)||H;k.rd=A;var I=b[g].update(A.J());p(I)?(hg("transaction failed: Data returned ",
I,k.path),m=Q(I),"object"===typeof I&&null!=I&&y(I,".priority")||(m=m.ia(A.C())),A=k.Da,I=Mi(a),I=Xc(m,I),k.sd=m,k.td=I,k.Da=a.Kd++,Ta(f,A),e=e.concat(pi(a.M,k.path,I,k.Da,k.gf)),e=e.concat(si(a.M,A,!0))):(l=!0,t="nodata",e=e.concat(si(a.M,k.Da,!0)))}dc(a.fa,c,e);e=[];l&&(b[g].status=3,setTimeout(b[g].le,Math.floor(0)),b[g].I&&("nodata"===t?(k=new X(a,b[g].path),d.push(u(b[g].I,null,null,!1,new W(b[g].rd,k,R)))):d.push(u(b[g].I,null,Error(t),!1,null))))}Ui(a,a.yc);for(g=0;g<d.length;g++)gc(d[g]);
Ti(a)}}function Xi(a,b){for(var c,d=a.yc;null!==(c=K(b))&&null===d.Ea();)d=Xf(d,c),b=N(b);return d}function Vi(a,b){var c=[];Zi(a,b,c);c.sort(function(a,b){return a.Lf-b.Lf});return c}function Zi(a,b,c){var d=b.Ea();if(null!==d)for(var e=0;e<d.length;e++)c.push(d[e]);b.R(function(b){Zi(a,b,c)})}function Ui(a,b){var c=b.Ea();if(c){for(var d=0,e=0;e<c.length;e++)3!==c[e].status&&(c[d]=c[e],d++);c.length=d;Yf(b,0<c.length?c:null)}b.R(function(b){Ui(a,b)})}
function Qi(a,b){var c=Xi(a,b).path(),d=Xf(a.yc,b);ag(d,function(b){$i(a,b)});$i(a,d);$f(d,function(b){$i(a,b)});return c}
function $i(a,b){var c=b.Ea();if(null!==c){for(var d=[],e=[],f=-1,g=0;g<c.length;g++)4!==c[g].status&&(2===c[g].status?(O(f===g-1,"All SENT items should be at beginning of queue."),f=g,c[g].status=4,c[g].ne="set"):(O(1===c[g].status,"Unexpected transaction status in abort"),c[g].le(),e=e.concat(si(a.M,c[g].Da,!0)),c[g].I&&d.push(u(c[g].I,null,Error("set"),!1,null))));-1===f?Yf(b,null):c.length=f+1;dc(a.fa,b.path(),e);for(g=0;g<d.length;g++)gc(d[g])}};function aj(){this.sc={};this.ag=!1}aj.prototype.Cb=function(){for(var a in this.sc)this.sc[a].Cb()};aj.prototype.vc=function(){for(var a in this.sc)this.sc[a].vc()};aj.prototype.ze=function(){this.ag=!0};ba(aj);aj.prototype.interrupt=aj.prototype.Cb;aj.prototype.resume=aj.prototype.vc;function Y(a,b,c,d){this.k=a;this.path=b;this.n=c;this.pc=d}
function bj(a){var b=null,c=null;a.oa&&(b=Od(a));a.ra&&(c=Rd(a));if(a.g===re){if(a.oa){if("[MIN_NAME]"!=Nd(a))throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");if("string"!==typeof b)throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");}if(a.ra){if("[MAX_NAME]"!=Pd(a))throw Error("Query: When ordering by key, you may only pass one argument to startAt(), endAt(), or equalTo().");if("string"!==
typeof c)throw Error("Query: When ordering by key, the argument passed to startAt(), endAt(),or equalTo() must be a string.");}}else if(a.g===R){if(null!=b&&!fg(b)||null!=c&&!fg(c))throw Error("Query: When ordering by priority, the first argument passed to startAt(), endAt(), or equalTo() must be a valid priority value (null, a number, or a string).");}else if(O(a.g instanceof ve||a.g===Be,"unknown index type."),null!=b&&"object"===typeof b||null!=c&&"object"===typeof c)throw Error("Query: First argument passed to startAt(), endAt(), or equalTo() cannot be an object.");
}function cj(a){if(a.oa&&a.ra&&a.la&&(!a.la||""===a.Rb))throw Error("Query: Can't combine startAt(), endAt(), and limit(). Use limitToFirst() or limitToLast() instead.");}function dj(a,b){if(!0===a.pc)throw Error(b+": You can't combine multiple orderBy calls.");}h=Y.prototype;h.Mb=function(){D("Query.ref",0,0,arguments.length);return new X(this.k,this.path)};
h.Ib=function(a,b,c,d){D("Query.on",2,4,arguments.length);lg("Query.on",a,!1);F("Query.on",2,b,!1);var e=ej("Query.on",c,d);if("value"===a)Ri(this.k,this,new ii(b,e.cancel||null,e.Qa||null));else{var f={};f[a]=b;Ri(this.k,this,new ji(f,e.cancel,e.Qa))}return b};
h.mc=function(a,b,c){D("Query.off",0,3,arguments.length);lg("Query.off",a,!0);F("Query.off",2,b,!0);Qb("Query.off",3,c);var d=null,e=null;"value"===a?d=new ii(b||null,null,c||null):a&&(b&&(e={},e[a]=b),d=new ji(e,null,c||null));e=this.k;d=".info"===K(this.path)?e.Fd.nb(this,d):e.M.nb(this,d);bc(e.fa,this.path,d)};
h.Pg=function(a,b){function c(k){f&&(f=!1,e.mc(a,c),b&&b.call(d.Qa,k),g.resolve(k))}D("Query.once",1,4,arguments.length);lg("Query.once",a,!1);F("Query.once",2,b,!0);var d=ej("Query.once",arguments[2],arguments[3]),e=this,f=!0,g=new B;Nb(g.D);this.Ib(a,c,function(b){e.mc(a,c);d.cancel&&d.cancel.call(d.Qa,b);g.reject(b)});return g.D};
h.Le=function(a){S("Query.limit() being deprecated. Please use Query.limitToFirst() or Query.limitToLast() instead.");D("Query.limit",1,1,arguments.length);if(!fa(a)||Math.floor(a)!==a||0>=a)throw Error("Query.limit: First argument must be a positive integer.");if(this.n.la)throw Error("Query.limit: Limit was already set (by another call to limit, limitToFirst, orlimitToLast.");var b=this.n.Le(a);cj(b);return new Y(this.k,this.path,b,this.pc)};
h.Me=function(a){D("Query.limitToFirst",1,1,arguments.length);if(!fa(a)||Math.floor(a)!==a||0>=a)throw Error("Query.limitToFirst: First argument must be a positive integer.");if(this.n.la)throw Error("Query.limitToFirst: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");return new Y(this.k,this.path,this.n.Me(a),this.pc)};
h.Ne=function(a){D("Query.limitToLast",1,1,arguments.length);if(!fa(a)||Math.floor(a)!==a||0>=a)throw Error("Query.limitToLast: First argument must be a positive integer.");if(this.n.la)throw Error("Query.limitToLast: Limit was already set (by another call to limit, limitToFirst, or limitToLast).");return new Y(this.k,this.path,this.n.Ne(a),this.pc)};
h.Qg=function(a){D("Query.orderByChild",1,1,arguments.length);if("$key"===a)throw Error('Query.orderByChild: "$key" is invalid.  Use Query.orderByKey() instead.');if("$priority"===a)throw Error('Query.orderByChild: "$priority" is invalid.  Use Query.orderByPriority() instead.');if("$value"===a)throw Error('Query.orderByChild: "$value" is invalid.  Use Query.orderByValue() instead.');ng("Query.orderByChild",a);dj(this,"Query.orderByChild");var b=new P(a);if(b.e())throw Error("Query.orderByChild: cannot pass in empty path.  Use Query.orderByValue() instead.");
b=new ve(b);b=Fe(this.n,b);bj(b);return new Y(this.k,this.path,b,!0)};h.Rg=function(){D("Query.orderByKey",0,0,arguments.length);dj(this,"Query.orderByKey");var a=Fe(this.n,re);bj(a);return new Y(this.k,this.path,a,!0)};h.Sg=function(){D("Query.orderByPriority",0,0,arguments.length);dj(this,"Query.orderByPriority");var a=Fe(this.n,R);bj(a);return new Y(this.k,this.path,a,!0)};
h.Tg=function(){D("Query.orderByValue",0,0,arguments.length);dj(this,"Query.orderByValue");var a=Fe(this.n,Be);bj(a);return new Y(this.k,this.path,a,!0)};h.ce=function(a,b){D("Query.startAt",0,2,arguments.length);gg("Query.startAt",a,this.path,!0);mg("Query.startAt",b);var c=this.n.ce(a,b);cj(c);bj(c);if(this.n.oa)throw Error("Query.startAt: Starting point was already set (by another call to startAt or equalTo).");p(a)||(b=a=null);return new Y(this.k,this.path,c,this.pc)};
h.vd=function(a,b){D("Query.endAt",0,2,arguments.length);gg("Query.endAt",a,this.path,!0);mg("Query.endAt",b);var c=this.n.vd(a,b);cj(c);bj(c);if(this.n.ra)throw Error("Query.endAt: Ending point was already set (by another call to endAt or equalTo).");return new Y(this.k,this.path,c,this.pc)};
h.tg=function(a,b){D("Query.equalTo",1,2,arguments.length);gg("Query.equalTo",a,this.path,!1);mg("Query.equalTo",b);if(this.n.oa)throw Error("Query.equalTo: Starting point was already set (by another call to endAt or equalTo).");if(this.n.ra)throw Error("Query.equalTo: Ending point was already set (by another call to endAt or equalTo).");return this.ce(a,b).vd(a,b)};
h.toString=function(){D("Query.toString",0,0,arguments.length);for(var a=this.path,b="",c=a.aa;c<a.u.length;c++)""!==a.u[c]&&(b+="/"+encodeURIComponent(String(a.u[c])));return this.k.toString()+(b||"/")};h.wa=function(){var a=xd(Ge(this.n));return"{}"===a?"default":a};
function ej(a,b,c){var d={cancel:null,Qa:null};if(b&&c)d.cancel=b,F(a,3,d.cancel,!0),d.Qa=c,Qb(a,4,d.Qa);else if(b)if("object"===typeof b&&null!==b)d.Qa=b;else if("function"===typeof b)d.cancel=b;else throw Error(E(a,3,!0)+" must either be a cancel callback or a context object.");return d}Y.prototype.ref=Y.prototype.Mb;Y.prototype.on=Y.prototype.Ib;Y.prototype.off=Y.prototype.mc;Y.prototype.once=Y.prototype.Pg;Y.prototype.limit=Y.prototype.Le;Y.prototype.limitToFirst=Y.prototype.Me;
Y.prototype.limitToLast=Y.prototype.Ne;Y.prototype.orderByChild=Y.prototype.Qg;Y.prototype.orderByKey=Y.prototype.Rg;Y.prototype.orderByPriority=Y.prototype.Sg;Y.prototype.orderByValue=Y.prototype.Tg;Y.prototype.startAt=Y.prototype.ce;Y.prototype.endAt=Y.prototype.vd;Y.prototype.equalTo=Y.prototype.tg;Y.prototype.toString=Y.prototype.toString;var Z={};Z.zc=Rh;Z.DataConnection=Z.zc;Rh.prototype.dh=function(a,b){this.Ia("q",{p:a},b)};Z.zc.prototype.simpleListen=Z.zc.prototype.dh;Rh.prototype.sg=function(a,b){this.Ia("echo",{d:a},b)};Z.zc.prototype.echo=Z.zc.prototype.sg;Rh.prototype.interrupt=Rh.prototype.Cb;Z.dg=Fh;Z.RealTimeConnection=Z.dg;Fh.prototype.sendRequest=Fh.prototype.Ia;Fh.prototype.close=Fh.prototype.close;
Z.Cg=function(a){var b=Rh.prototype.put;Rh.prototype.put=function(c,d,e,f){p(f)&&(f=a());b.call(this,c,d,e,f)};return function(){Rh.prototype.put=b}};Z.hijackHash=Z.Cg;Z.cg=dd;Z.ConnectionTarget=Z.cg;Z.wa=function(a){return a.wa()};Z.queryIdentifier=Z.wa;Z.Fg=function(a){return a.k.Va.ba};Z.listens=Z.Fg;Z.ze=function(a){a.ze()};Z.forceRestClient=Z.ze;function X(a,b){var c,d,e;if(a instanceof Ji)c=a,d=b;else{D("new Firebase",1,2,arguments.length);d=sd(arguments[0]);c=d.fh;"firebase"===d.domain&&rd(d.host+" is no longer supported. Please use <YOUR FIREBASE>.firebaseio.com instead");c&&"undefined"!=c||rd("Cannot parse Firebase url. Please use https://<YOUR FIREBASE>.firebaseio.com");d.ob||"undefined"!==typeof window&&window.location&&window.location.protocol&&-1!==window.location.protocol.indexOf("https:")&&S("Insecure Firebase access from a secure page. Please use https in calls to new Firebase().");
c=new dd(d.host,d.ob,c,"ws"===d.scheme||"wss"===d.scheme);d=new P(d.bd);e=d.toString();var f;!(f=!q(c.host)||0===c.host.length||!eg(c.lc))&&(f=0!==e.length)&&(e&&(e=e.replace(/^\/*\.info(\/|$)/,"/")),f=!(q(e)&&0!==e.length&&!cg.test(e)));if(f)throw Error(E("new Firebase",1,!1)+'must be a valid firebase URL and the path can\'t contain ".", "#", "$", "[", or "]".');if(b)if(b instanceof aj)e=b;else if(q(b))e=aj.yb(),c.Rd=b;else throw Error("Expected a valid Firebase.Context for second argument to new Firebase()");
else e=aj.yb();f=c.toString();var g=z(e.sc,f);g||(g=new Ji(c,e.ag),e.sc[f]=g);c=g}Y.call(this,c,d,De,!1);this.then=void 0;this["catch"]=void 0}ka(X,Y);var fj=X,gj=["Firebase"],hj=n;gj[0]in hj||!hj.execScript||hj.execScript("var "+gj[0]);for(var ij;gj.length&&(ij=gj.shift());)!gj.length&&p(fj)?hj[ij]=fj:hj=hj[ij]?hj[ij]:hj[ij]={};X.goOffline=function(){D("Firebase.goOffline",0,0,arguments.length);aj.yb().Cb()};X.goOnline=function(){D("Firebase.goOnline",0,0,arguments.length);aj.yb().vc()};
X.enableLogging=od;X.ServerValue={TIMESTAMP:{".sv":"timestamp"}};X.SDK_VERSION=Eb;X.INTERNAL=U;X.Context=aj;X.TEST_ACCESS=Z;X.prototype.name=function(){S("Firebase.name() being deprecated. Please use Firebase.key() instead.");D("Firebase.name",0,0,arguments.length);return this.key()};X.prototype.name=X.prototype.name;X.prototype.key=function(){D("Firebase.key",0,0,arguments.length);return this.path.e()?null:me(this.path)};X.prototype.key=X.prototype.key;
X.prototype.o=function(a){D("Firebase.child",1,1,arguments.length);if(fa(a))a=String(a);else if(!(a instanceof P))if(null===K(this.path)){var b=a;b&&(b=b.replace(/^\/*\.info(\/|$)/,"/"));ng("Firebase.child",b)}else ng("Firebase.child",a);return new X(this.k,this.path.o(a))};X.prototype.child=X.prototype.o;X.prototype.parent=function(){D("Firebase.parent",0,0,arguments.length);var a=this.path.parent();return null===a?null:new X(this.k,a)};X.prototype.parent=X.prototype.parent;
X.prototype.root=function(){D("Firebase.ref",0,0,arguments.length);for(var a=this;null!==a.parent();)a=a.parent();return a};X.prototype.root=X.prototype.root;X.prototype.set=function(a,b){D("Firebase.set",1,2,arguments.length);og("Firebase.set",this.path);gg("Firebase.set",a,this.path,!1);F("Firebase.set",2,b,!0);var c=new B;this.k.Ob(this.path,a,null,C(c,b));return c.D};X.prototype.set=X.prototype.set;
X.prototype.update=function(a,b){D("Firebase.update",1,2,arguments.length);og("Firebase.update",this.path);if(da(a)){for(var c={},d=0;d<a.length;++d)c[""+d]=a[d];a=c;S("Passing an Array to Firebase.update() is deprecated. Use set() if you want to overwrite the existing data, or an Object with integer keys if you really do want to only update some of the children.")}jg("Firebase.update",a,this.path);F("Firebase.update",2,b,!0);c=new B;this.k.update(this.path,a,C(c,b));return c.D};
X.prototype.update=X.prototype.update;X.prototype.Ob=function(a,b,c){D("Firebase.setWithPriority",2,3,arguments.length);og("Firebase.setWithPriority",this.path);gg("Firebase.setWithPriority",a,this.path,!1);kg("Firebase.setWithPriority",2,b);F("Firebase.setWithPriority",3,c,!0);if(".length"===this.key()||".keys"===this.key())throw"Firebase.setWithPriority failed: "+this.key()+" is a read-only object.";var d=new B;this.k.Ob(this.path,a,b,C(d,c));return d.D};X.prototype.setWithPriority=X.prototype.Ob;
X.prototype.remove=function(a){D("Firebase.remove",0,1,arguments.length);og("Firebase.remove",this.path);F("Firebase.remove",1,a,!0);return this.set(null,a)};X.prototype.remove=X.prototype.remove;
X.prototype.transaction=function(a,b,c){D("Firebase.transaction",1,3,arguments.length);og("Firebase.transaction",this.path);F("Firebase.transaction",1,a,!1);F("Firebase.transaction",2,b,!0);if(p(c)&&"boolean"!=typeof c)throw Error(E("Firebase.transaction",3,!0)+"must be a boolean.");if(".length"===this.key()||".keys"===this.key())throw"Firebase.transaction failed: "+this.key()+" is a read-only object.";"undefined"===typeof c&&(c=!0);var d=new B;r(b)&&Nb(d.D);Si(this.k,this.path,a,function(a,c,g){a?
d.reject(a):d.resolve(new ei(c,g));r(b)&&b(a,c,g)},c);return d.D};X.prototype.transaction=X.prototype.transaction;X.prototype.$g=function(a,b){D("Firebase.setPriority",1,2,arguments.length);og("Firebase.setPriority",this.path);kg("Firebase.setPriority",1,a);F("Firebase.setPriority",2,b,!0);var c=new B;this.k.Ob(this.path.o(".priority"),a,null,C(c,b));return c.D};X.prototype.setPriority=X.prototype.$g;
X.prototype.push=function(a,b){D("Firebase.push",0,2,arguments.length);og("Firebase.push",this.path);gg("Firebase.push",a,this.path,!0);F("Firebase.push",2,b,!0);var c=Li(this.k),d=hf(c),c=this.o(d);if(null!=a){var e=this,f=c.set(a,b).then(function(){return e.o(d)});c.then=u(f.then,f);c["catch"]=u(f.then,f,void 0);r(b)&&Nb(f)}return c};X.prototype.push=X.prototype.push;X.prototype.lb=function(){og("Firebase.onDisconnect",this.path);return new V(this.k,this.path)};X.prototype.onDisconnect=X.prototype.lb;
X.prototype.O=function(a,b,c){S("FirebaseRef.auth() being deprecated. Please use FirebaseRef.authWithCustomToken() instead.");D("Firebase.auth",1,3,arguments.length);pg("Firebase.auth",a);F("Firebase.auth",2,b,!0);F("Firebase.auth",3,b,!0);var d=new B;dh(this.k.O,a,{},{remember:"none"},C(d,b),c);return d.D};X.prototype.auth=X.prototype.O;X.prototype.je=function(a){D("Firebase.unauth",0,1,arguments.length);F("Firebase.unauth",1,a,!0);var b=new B;eh(this.k.O,C(b,a));return b.D};X.prototype.unauth=X.prototype.je;
X.prototype.Be=function(){D("Firebase.getAuth",0,0,arguments.length);return this.k.O.Be()};X.prototype.getAuth=X.prototype.Be;X.prototype.Jg=function(a,b){D("Firebase.onAuth",1,2,arguments.length);F("Firebase.onAuth",1,a,!1);Qb("Firebase.onAuth",2,b);this.k.O.Ib("auth_status",a,b)};X.prototype.onAuth=X.prototype.Jg;X.prototype.Ig=function(a,b){D("Firebase.offAuth",1,2,arguments.length);F("Firebase.offAuth",1,a,!1);Qb("Firebase.offAuth",2,b);this.k.O.mc("auth_status",a,b)};X.prototype.offAuth=X.prototype.Ig;
X.prototype.hg=function(a,b,c){D("Firebase.authWithCustomToken",1,3,arguments.length);2===arguments.length&&Hb(b)&&(c=b,b=void 0);pg("Firebase.authWithCustomToken",a);F("Firebase.authWithCustomToken",2,b,!0);sg("Firebase.authWithCustomToken",3,c,!0);var d=new B;dh(this.k.O,a,{},c||{},C(d,b));return d.D};X.prototype.authWithCustomToken=X.prototype.hg;
X.prototype.ig=function(a,b,c){D("Firebase.authWithOAuthPopup",1,3,arguments.length);2===arguments.length&&Hb(b)&&(c=b,b=void 0);rg("Firebase.authWithOAuthPopup",a);F("Firebase.authWithOAuthPopup",2,b,!0);sg("Firebase.authWithOAuthPopup",3,c,!0);var d=new B;ih(this.k.O,a,c,C(d,b));return d.D};X.prototype.authWithOAuthPopup=X.prototype.ig;
X.prototype.jg=function(a,b,c){D("Firebase.authWithOAuthRedirect",1,3,arguments.length);2===arguments.length&&Hb(b)&&(c=b,b=void 0);rg("Firebase.authWithOAuthRedirect",a);F("Firebase.authWithOAuthRedirect",2,b,!1);sg("Firebase.authWithOAuthRedirect",3,c,!0);var d=new B,e=this.k.O,f=c,g=C(d,b);gh(e);var k=[Qg],f=Ag(f);"anonymous"===a||"firebase"===a?T(g,Sg("TRANSPORT_UNAVAILABLE")):(cd.set("redirect_client_options",f.qd),hh(e,k,"/auth/"+a,f,g));return d.D};X.prototype.authWithOAuthRedirect=X.prototype.jg;
X.prototype.kg=function(a,b,c,d){D("Firebase.authWithOAuthToken",2,4,arguments.length);3===arguments.length&&Hb(c)&&(d=c,c=void 0);rg("Firebase.authWithOAuthToken",a);F("Firebase.authWithOAuthToken",3,c,!0);sg("Firebase.authWithOAuthToken",4,d,!0);var e=new B;q(b)?(qg("Firebase.authWithOAuthToken",2,b),fh(this.k.O,a+"/token",{access_token:b},d,C(e,c))):(sg("Firebase.authWithOAuthToken",2,b,!1),fh(this.k.O,a+"/token",b,d,C(e,c)));return e.D};X.prototype.authWithOAuthToken=X.prototype.kg;
X.prototype.gg=function(a,b){D("Firebase.authAnonymously",0,2,arguments.length);1===arguments.length&&Hb(a)&&(b=a,a=void 0);F("Firebase.authAnonymously",1,a,!0);sg("Firebase.authAnonymously",2,b,!0);var c=new B;fh(this.k.O,"anonymous",{},b,C(c,a));return c.D};X.prototype.authAnonymously=X.prototype.gg;
X.prototype.lg=function(a,b,c){D("Firebase.authWithPassword",1,3,arguments.length);2===arguments.length&&Hb(b)&&(c=b,b=void 0);sg("Firebase.authWithPassword",1,a,!1);tg("Firebase.authWithPassword",a,"email");tg("Firebase.authWithPassword",a,"password");F("Firebase.authWithPassword",2,b,!0);sg("Firebase.authWithPassword",3,c,!0);var d=new B;fh(this.k.O,"password",a,c,C(d,b));return d.D};X.prototype.authWithPassword=X.prototype.lg;
X.prototype.ve=function(a,b){D("Firebase.createUser",1,2,arguments.length);sg("Firebase.createUser",1,a,!1);tg("Firebase.createUser",a,"email");tg("Firebase.createUser",a,"password");F("Firebase.createUser",2,b,!0);var c=new B;this.k.O.ve(a,C(c,b));return c.D};X.prototype.createUser=X.prototype.ve;
X.prototype.Xe=function(a,b){D("Firebase.removeUser",1,2,arguments.length);sg("Firebase.removeUser",1,a,!1);tg("Firebase.removeUser",a,"email");tg("Firebase.removeUser",a,"password");F("Firebase.removeUser",2,b,!0);var c=new B;this.k.O.Xe(a,C(c,b));return c.D};X.prototype.removeUser=X.prototype.Xe;
X.prototype.se=function(a,b){D("Firebase.changePassword",1,2,arguments.length);sg("Firebase.changePassword",1,a,!1);tg("Firebase.changePassword",a,"email");tg("Firebase.changePassword",a,"oldPassword");tg("Firebase.changePassword",a,"newPassword");F("Firebase.changePassword",2,b,!0);var c=new B;this.k.O.se(a,C(c,b));return c.D};X.prototype.changePassword=X.prototype.se;
X.prototype.re=function(a,b){D("Firebase.changeEmail",1,2,arguments.length);sg("Firebase.changeEmail",1,a,!1);tg("Firebase.changeEmail",a,"oldEmail");tg("Firebase.changeEmail",a,"newEmail");tg("Firebase.changeEmail",a,"password");F("Firebase.changeEmail",2,b,!0);var c=new B;this.k.O.re(a,C(c,b));return c.D};X.prototype.changeEmail=X.prototype.re;
X.prototype.Ze=function(a,b){D("Firebase.resetPassword",1,2,arguments.length);sg("Firebase.resetPassword",1,a,!1);tg("Firebase.resetPassword",a,"email");F("Firebase.resetPassword",2,b,!0);var c=new B;this.k.O.Ze(a,C(c,b));return c.D};X.prototype.resetPassword=X.prototype.Ze;})();

module.exports = Firebase;

},{}],169:[function(require,module,exports){
/**
 * Copyright (c) 2014-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

module.exports.Dispatcher = require('./lib/Dispatcher');

},{"./lib/Dispatcher":170}],170:[function(require,module,exports){
(function (process){
/**
 * Copyright (c) 2014-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule Dispatcher
 * 
 * @preventMunge
 */

'use strict';

exports.__esModule = true;

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } }

var invariant = require('fbjs/lib/invariant');

var _prefix = 'ID_';

/**
 * Dispatcher is used to broadcast payloads to registered callbacks. This is
 * different from generic pub-sub systems in two ways:
 *
 *   1) Callbacks are not subscribed to particular events. Every payload is
 *      dispatched to every registered callback.
 *   2) Callbacks can be deferred in whole or part until other callbacks have
 *      been executed.
 *
 * For example, consider this hypothetical flight destination form, which
 * selects a default city when a country is selected:
 *
 *   var flightDispatcher = new Dispatcher();
 *
 *   // Keeps track of which country is selected
 *   var CountryStore = {country: null};
 *
 *   // Keeps track of which city is selected
 *   var CityStore = {city: null};
 *
 *   // Keeps track of the base flight price of the selected city
 *   var FlightPriceStore = {price: null}
 *
 * When a user changes the selected city, we dispatch the payload:
 *
 *   flightDispatcher.dispatch({
 *     actionType: 'city-update',
 *     selectedCity: 'paris'
 *   });
 *
 * This payload is digested by `CityStore`:
 *
 *   flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'city-update') {
 *       CityStore.city = payload.selectedCity;
 *     }
 *   });
 *
 * When the user selects a country, we dispatch the payload:
 *
 *   flightDispatcher.dispatch({
 *     actionType: 'country-update',
 *     selectedCountry: 'australia'
 *   });
 *
 * This payload is digested by both stores:
 *
 *   CountryStore.dispatchToken = flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'country-update') {
 *       CountryStore.country = payload.selectedCountry;
 *     }
 *   });
 *
 * When the callback to update `CountryStore` is registered, we save a reference
 * to the returned token. Using this token with `waitFor()`, we can guarantee
 * that `CountryStore` is updated before the callback that updates `CityStore`
 * needs to query its data.
 *
 *   CityStore.dispatchToken = flightDispatcher.register(function(payload) {
 *     if (payload.actionType === 'country-update') {
 *       // `CountryStore.country` may not be updated.
 *       flightDispatcher.waitFor([CountryStore.dispatchToken]);
 *       // `CountryStore.country` is now guaranteed to be updated.
 *
 *       // Select the default city for the new country
 *       CityStore.city = getDefaultCityForCountry(CountryStore.country);
 *     }
 *   });
 *
 * The usage of `waitFor()` can be chained, for example:
 *
 *   FlightPriceStore.dispatchToken =
 *     flightDispatcher.register(function(payload) {
 *       switch (payload.actionType) {
 *         case 'country-update':
 *         case 'city-update':
 *           flightDispatcher.waitFor([CityStore.dispatchToken]);
 *           FlightPriceStore.price =
 *             getFlightPriceStore(CountryStore.country, CityStore.city);
 *           break;
 *     }
 *   });
 *
 * The `country-update` payload will be guaranteed to invoke the stores'
 * registered callbacks in order: `CountryStore`, `CityStore`, then
 * `FlightPriceStore`.
 */

var Dispatcher = (function () {
  function Dispatcher() {
    _classCallCheck(this, Dispatcher);

    this._callbacks = {};
    this._isDispatching = false;
    this._isHandled = {};
    this._isPending = {};
    this._lastID = 1;
  }

  /**
   * Registers a callback to be invoked with every dispatched payload. Returns
   * a token that can be used with `waitFor()`.
   */

  Dispatcher.prototype.register = function register(callback) {
    var id = _prefix + this._lastID++;
    this._callbacks[id] = callback;
    return id;
  };

  /**
   * Removes a callback based on its token.
   */

  Dispatcher.prototype.unregister = function unregister(id) {
    !this._callbacks[id] ? process.env.NODE_ENV !== 'production' ? invariant(false, 'Dispatcher.unregister(...): `%s` does not map to a registered callback.', id) : invariant(false) : undefined;
    delete this._callbacks[id];
  };

  /**
   * Waits for the callbacks specified to be invoked before continuing execution
   * of the current callback. This method should only be used by a callback in
   * response to a dispatched payload.
   */

  Dispatcher.prototype.waitFor = function waitFor(ids) {
    !this._isDispatching ? process.env.NODE_ENV !== 'production' ? invariant(false, 'Dispatcher.waitFor(...): Must be invoked while dispatching.') : invariant(false) : undefined;
    for (var ii = 0; ii < ids.length; ii++) {
      var id = ids[ii];
      if (this._isPending[id]) {
        !this._isHandled[id] ? process.env.NODE_ENV !== 'production' ? invariant(false, 'Dispatcher.waitFor(...): Circular dependency detected while ' + 'waiting for `%s`.', id) : invariant(false) : undefined;
        continue;
      }
      !this._callbacks[id] ? process.env.NODE_ENV !== 'production' ? invariant(false, 'Dispatcher.waitFor(...): `%s` does not map to a registered callback.', id) : invariant(false) : undefined;
      this._invokeCallback(id);
    }
  };

  /**
   * Dispatches a payload to all registered callbacks.
   */

  Dispatcher.prototype.dispatch = function dispatch(payload) {
    !!this._isDispatching ? process.env.NODE_ENV !== 'production' ? invariant(false, 'Dispatch.dispatch(...): Cannot dispatch in the middle of a dispatch.') : invariant(false) : undefined;
    this._startDispatching(payload);
    try {
      for (var id in this._callbacks) {
        if (this._isPending[id]) {
          continue;
        }
        this._invokeCallback(id);
      }
    } finally {
      this._stopDispatching();
    }
  };

  /**
   * Is this Dispatcher currently dispatching.
   */

  Dispatcher.prototype.isDispatching = function isDispatching() {
    return this._isDispatching;
  };

  /**
   * Call the callback stored with the given id. Also do some internal
   * bookkeeping.
   *
   * @internal
   */

  Dispatcher.prototype._invokeCallback = function _invokeCallback(id) {
    this._isPending[id] = true;
    this._callbacks[id](this._pendingPayload);
    this._isHandled[id] = true;
  };

  /**
   * Set up bookkeeping needed when dispatching.
   *
   * @internal
   */

  Dispatcher.prototype._startDispatching = function _startDispatching(payload) {
    for (var id in this._callbacks) {
      this._isPending[id] = false;
      this._isHandled[id] = false;
    }
    this._pendingPayload = payload;
    this._isDispatching = true;
  };

  /**
   * Clear bookkeeping used for dispatching.
   *
   * @internal
   */

  Dispatcher.prototype._stopDispatching = function _stopDispatching() {
    delete this._pendingPayload;
    this._isDispatching = false;
  };

  return Dispatcher;
})();

module.exports = Dispatcher;
}).call(this,require("ngpmcQ"))
},{"fbjs/lib/invariant":171,"ngpmcQ":176}],171:[function(require,module,exports){
(function (process){
/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule invariant
 */

"use strict";

/**
 * Use invariant() to assert state which your program assumes to be true.
 *
 * Provide sprintf-style format (only %s is supported) and arguments
 * to provide information about what broke and what you were
 * expecting.
 *
 * The invariant message will be stripped in production, but the invariant
 * will remain to ensure logic does not differ in production.
 */

var invariant = function (condition, format, a, b, c, d, e, f) {
  if (process.env.NODE_ENV !== 'production') {
    if (format === undefined) {
      throw new Error('invariant requires an error message argument');
    }
  }

  if (!condition) {
    var error;
    if (format === undefined) {
      error = new Error('Minified exception occurred; use the non-minified dev environment ' + 'for the full error message and additional helpful warnings.');
    } else {
      var args = [a, b, c, d, e, f];
      var argIndex = 0;
      error = new Error('Invariant Violation: ' + format.replace(/%s/g, function () {
        return args[argIndex++];
      }));
    }

    error.framesToPop = 1; // we don't care about invariant's own frame
    throw error;
  }
};

module.exports = invariant;
}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],172:[function(require,module,exports){
/*!
 * The buffer module from node.js, for the browser.
 *
 * @author   Feross Aboukhadijeh <feross@feross.org> <http://feross.org>
 * @license  MIT
 */

var base64 = require('base64-js')
var ieee754 = require('ieee754')

exports.Buffer = Buffer
exports.SlowBuffer = Buffer
exports.INSPECT_MAX_BYTES = 50
Buffer.poolSize = 8192

/**
 * If `Buffer._useTypedArrays`:
 *   === true    Use Uint8Array implementation (fastest)
 *   === false   Use Object implementation (compatible down to IE6)
 */
Buffer._useTypedArrays = (function () {
  // Detect if browser supports Typed Arrays. Supported browsers are IE 10+, Firefox 4+,
  // Chrome 7+, Safari 5.1+, Opera 11.6+, iOS 4.2+. If the browser does not support adding
  // properties to `Uint8Array` instances, then that's the same as no `Uint8Array` support
  // because we need to be able to add all the node Buffer API methods. This is an issue
  // in Firefox 4-29. Now fixed: https://bugzilla.mozilla.org/show_bug.cgi?id=695438
  try {
    var buf = new ArrayBuffer(0)
    var arr = new Uint8Array(buf)
    arr.foo = function () { return 42 }
    return 42 === arr.foo() &&
        typeof arr.subarray === 'function' // Chrome 9-10 lack `subarray`
  } catch (e) {
    return false
  }
})()

/**
 * Class: Buffer
 * =============
 *
 * The Buffer constructor returns instances of `Uint8Array` that are augmented
 * with function properties for all the node `Buffer` API functions. We use
 * `Uint8Array` so that square bracket notation works as expected -- it returns
 * a single octet.
 *
 * By augmenting the instances, we can avoid modifying the `Uint8Array`
 * prototype.
 */
function Buffer (subject, encoding, noZero) {
  if (!(this instanceof Buffer))
    return new Buffer(subject, encoding, noZero)

  var type = typeof subject

  // Workaround: node's base64 implementation allows for non-padded strings
  // while base64-js does not.
  if (encoding === 'base64' && type === 'string') {
    subject = stringtrim(subject)
    while (subject.length % 4 !== 0) {
      subject = subject + '='
    }
  }

  // Find the length
  var length
  if (type === 'number')
    length = coerce(subject)
  else if (type === 'string')
    length = Buffer.byteLength(subject, encoding)
  else if (type === 'object')
    length = coerce(subject.length) // assume that object is array-like
  else
    throw new Error('First argument needs to be a number, array or string.')

  var buf
  if (Buffer._useTypedArrays) {
    // Preferred: Return an augmented `Uint8Array` instance for best performance
    buf = Buffer._augment(new Uint8Array(length))
  } else {
    // Fallback: Return THIS instance of Buffer (created by `new`)
    buf = this
    buf.length = length
    buf._isBuffer = true
  }

  var i
  if (Buffer._useTypedArrays && typeof subject.byteLength === 'number') {
    // Speed optimization -- use set if we're copying from a typed array
    buf._set(subject)
  } else if (isArrayish(subject)) {
    // Treat array-ish objects as a byte array
    for (i = 0; i < length; i++) {
      if (Buffer.isBuffer(subject))
        buf[i] = subject.readUInt8(i)
      else
        buf[i] = subject[i]
    }
  } else if (type === 'string') {
    buf.write(subject, 0, encoding)
  } else if (type === 'number' && !Buffer._useTypedArrays && !noZero) {
    for (i = 0; i < length; i++) {
      buf[i] = 0
    }
  }

  return buf
}

// STATIC METHODS
// ==============

Buffer.isEncoding = function (encoding) {
  switch (String(encoding).toLowerCase()) {
    case 'hex':
    case 'utf8':
    case 'utf-8':
    case 'ascii':
    case 'binary':
    case 'base64':
    case 'raw':
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return true
    default:
      return false
  }
}

Buffer.isBuffer = function (b) {
  return !!(b !== null && b !== undefined && b._isBuffer)
}

Buffer.byteLength = function (str, encoding) {
  var ret
  str = str + ''
  switch (encoding || 'utf8') {
    case 'hex':
      ret = str.length / 2
      break
    case 'utf8':
    case 'utf-8':
      ret = utf8ToBytes(str).length
      break
    case 'ascii':
    case 'binary':
    case 'raw':
      ret = str.length
      break
    case 'base64':
      ret = base64ToBytes(str).length
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = str.length * 2
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.concat = function (list, totalLength) {
  assert(isArray(list), 'Usage: Buffer.concat(list, [totalLength])\n' +
      'list should be an Array.')

  if (list.length === 0) {
    return new Buffer(0)
  } else if (list.length === 1) {
    return list[0]
  }

  var i
  if (typeof totalLength !== 'number') {
    totalLength = 0
    for (i = 0; i < list.length; i++) {
      totalLength += list[i].length
    }
  }

  var buf = new Buffer(totalLength)
  var pos = 0
  for (i = 0; i < list.length; i++) {
    var item = list[i]
    item.copy(buf, pos)
    pos += item.length
  }
  return buf
}

// BUFFER INSTANCE METHODS
// =======================

function _hexWrite (buf, string, offset, length) {
  offset = Number(offset) || 0
  var remaining = buf.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }

  // must be an even number of digits
  var strLen = string.length
  assert(strLen % 2 === 0, 'Invalid hex string')

  if (length > strLen / 2) {
    length = strLen / 2
  }
  for (var i = 0; i < length; i++) {
    var byte = parseInt(string.substr(i * 2, 2), 16)
    assert(!isNaN(byte), 'Invalid hex string')
    buf[offset + i] = byte
  }
  Buffer._charsWritten = i * 2
  return i
}

function _utf8Write (buf, string, offset, length) {
  var charsWritten = Buffer._charsWritten =
    blitBuffer(utf8ToBytes(string), buf, offset, length)
  return charsWritten
}

function _asciiWrite (buf, string, offset, length) {
  var charsWritten = Buffer._charsWritten =
    blitBuffer(asciiToBytes(string), buf, offset, length)
  return charsWritten
}

function _binaryWrite (buf, string, offset, length) {
  return _asciiWrite(buf, string, offset, length)
}

function _base64Write (buf, string, offset, length) {
  var charsWritten = Buffer._charsWritten =
    blitBuffer(base64ToBytes(string), buf, offset, length)
  return charsWritten
}

function _utf16leWrite (buf, string, offset, length) {
  var charsWritten = Buffer._charsWritten =
    blitBuffer(utf16leToBytes(string), buf, offset, length)
  return charsWritten
}

Buffer.prototype.write = function (string, offset, length, encoding) {
  // Support both (string, offset, length, encoding)
  // and the legacy (string, encoding, offset, length)
  if (isFinite(offset)) {
    if (!isFinite(length)) {
      encoding = length
      length = undefined
    }
  } else {  // legacy
    var swap = encoding
    encoding = offset
    offset = length
    length = swap
  }

  offset = Number(offset) || 0
  var remaining = this.length - offset
  if (!length) {
    length = remaining
  } else {
    length = Number(length)
    if (length > remaining) {
      length = remaining
    }
  }
  encoding = String(encoding || 'utf8').toLowerCase()

  var ret
  switch (encoding) {
    case 'hex':
      ret = _hexWrite(this, string, offset, length)
      break
    case 'utf8':
    case 'utf-8':
      ret = _utf8Write(this, string, offset, length)
      break
    case 'ascii':
      ret = _asciiWrite(this, string, offset, length)
      break
    case 'binary':
      ret = _binaryWrite(this, string, offset, length)
      break
    case 'base64':
      ret = _base64Write(this, string, offset, length)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = _utf16leWrite(this, string, offset, length)
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.prototype.toString = function (encoding, start, end) {
  var self = this

  encoding = String(encoding || 'utf8').toLowerCase()
  start = Number(start) || 0
  end = (end !== undefined)
    ? Number(end)
    : end = self.length

  // Fastpath empty strings
  if (end === start)
    return ''

  var ret
  switch (encoding) {
    case 'hex':
      ret = _hexSlice(self, start, end)
      break
    case 'utf8':
    case 'utf-8':
      ret = _utf8Slice(self, start, end)
      break
    case 'ascii':
      ret = _asciiSlice(self, start, end)
      break
    case 'binary':
      ret = _binarySlice(self, start, end)
      break
    case 'base64':
      ret = _base64Slice(self, start, end)
      break
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      ret = _utf16leSlice(self, start, end)
      break
    default:
      throw new Error('Unknown encoding')
  }
  return ret
}

Buffer.prototype.toJSON = function () {
  return {
    type: 'Buffer',
    data: Array.prototype.slice.call(this._arr || this, 0)
  }
}

// copy(targetBuffer, targetStart=0, sourceStart=0, sourceEnd=buffer.length)
Buffer.prototype.copy = function (target, target_start, start, end) {
  var source = this

  if (!start) start = 0
  if (!end && end !== 0) end = this.length
  if (!target_start) target_start = 0

  // Copy 0 bytes; we're done
  if (end === start) return
  if (target.length === 0 || source.length === 0) return

  // Fatal error conditions
  assert(end >= start, 'sourceEnd < sourceStart')
  assert(target_start >= 0 && target_start < target.length,
      'targetStart out of bounds')
  assert(start >= 0 && start < source.length, 'sourceStart out of bounds')
  assert(end >= 0 && end <= source.length, 'sourceEnd out of bounds')

  // Are we oob?
  if (end > this.length)
    end = this.length
  if (target.length - target_start < end - start)
    end = target.length - target_start + start

  var len = end - start

  if (len < 100 || !Buffer._useTypedArrays) {
    for (var i = 0; i < len; i++)
      target[i + target_start] = this[i + start]
  } else {
    target._set(this.subarray(start, start + len), target_start)
  }
}

function _base64Slice (buf, start, end) {
  if (start === 0 && end === buf.length) {
    return base64.fromByteArray(buf)
  } else {
    return base64.fromByteArray(buf.slice(start, end))
  }
}

function _utf8Slice (buf, start, end) {
  var res = ''
  var tmp = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++) {
    if (buf[i] <= 0x7F) {
      res += decodeUtf8Char(tmp) + String.fromCharCode(buf[i])
      tmp = ''
    } else {
      tmp += '%' + buf[i].toString(16)
    }
  }

  return res + decodeUtf8Char(tmp)
}

function _asciiSlice (buf, start, end) {
  var ret = ''
  end = Math.min(buf.length, end)

  for (var i = start; i < end; i++)
    ret += String.fromCharCode(buf[i])
  return ret
}

function _binarySlice (buf, start, end) {
  return _asciiSlice(buf, start, end)
}

function _hexSlice (buf, start, end) {
  var len = buf.length

  if (!start || start < 0) start = 0
  if (!end || end < 0 || end > len) end = len

  var out = ''
  for (var i = start; i < end; i++) {
    out += toHex(buf[i])
  }
  return out
}

function _utf16leSlice (buf, start, end) {
  var bytes = buf.slice(start, end)
  var res = ''
  for (var i = 0; i < bytes.length; i += 2) {
    res += String.fromCharCode(bytes[i] + bytes[i+1] * 256)
  }
  return res
}

Buffer.prototype.slice = function (start, end) {
  var len = this.length
  start = clamp(start, len, 0)
  end = clamp(end, len, len)

  if (Buffer._useTypedArrays) {
    return Buffer._augment(this.subarray(start, end))
  } else {
    var sliceLen = end - start
    var newBuf = new Buffer(sliceLen, undefined, true)
    for (var i = 0; i < sliceLen; i++) {
      newBuf[i] = this[i + start]
    }
    return newBuf
  }
}

// `get` will be removed in Node 0.13+
Buffer.prototype.get = function (offset) {
  console.log('.get() is deprecated. Access using array indexes instead.')
  return this.readUInt8(offset)
}

// `set` will be removed in Node 0.13+
Buffer.prototype.set = function (v, offset) {
  console.log('.set() is deprecated. Access using array indexes instead.')
  return this.writeUInt8(v, offset)
}

Buffer.prototype.readUInt8 = function (offset, noAssert) {
  if (!noAssert) {
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'Trying to read beyond buffer length')
  }

  if (offset >= this.length)
    return

  return this[offset]
}

function _readUInt16 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val
  if (littleEndian) {
    val = buf[offset]
    if (offset + 1 < len)
      val |= buf[offset + 1] << 8
  } else {
    val = buf[offset] << 8
    if (offset + 1 < len)
      val |= buf[offset + 1]
  }
  return val
}

Buffer.prototype.readUInt16LE = function (offset, noAssert) {
  return _readUInt16(this, offset, true, noAssert)
}

Buffer.prototype.readUInt16BE = function (offset, noAssert) {
  return _readUInt16(this, offset, false, noAssert)
}

function _readUInt32 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val
  if (littleEndian) {
    if (offset + 2 < len)
      val = buf[offset + 2] << 16
    if (offset + 1 < len)
      val |= buf[offset + 1] << 8
    val |= buf[offset]
    if (offset + 3 < len)
      val = val + (buf[offset + 3] << 24 >>> 0)
  } else {
    if (offset + 1 < len)
      val = buf[offset + 1] << 16
    if (offset + 2 < len)
      val |= buf[offset + 2] << 8
    if (offset + 3 < len)
      val |= buf[offset + 3]
    val = val + (buf[offset] << 24 >>> 0)
  }
  return val
}

Buffer.prototype.readUInt32LE = function (offset, noAssert) {
  return _readUInt32(this, offset, true, noAssert)
}

Buffer.prototype.readUInt32BE = function (offset, noAssert) {
  return _readUInt32(this, offset, false, noAssert)
}

Buffer.prototype.readInt8 = function (offset, noAssert) {
  if (!noAssert) {
    assert(offset !== undefined && offset !== null,
        'missing offset')
    assert(offset < this.length, 'Trying to read beyond buffer length')
  }

  if (offset >= this.length)
    return

  var neg = this[offset] & 0x80
  if (neg)
    return (0xff - this[offset] + 1) * -1
  else
    return this[offset]
}

function _readInt16 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val = _readUInt16(buf, offset, littleEndian, true)
  var neg = val & 0x8000
  if (neg)
    return (0xffff - val + 1) * -1
  else
    return val
}

Buffer.prototype.readInt16LE = function (offset, noAssert) {
  return _readInt16(this, offset, true, noAssert)
}

Buffer.prototype.readInt16BE = function (offset, noAssert) {
  return _readInt16(this, offset, false, noAssert)
}

function _readInt32 (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  var len = buf.length
  if (offset >= len)
    return

  var val = _readUInt32(buf, offset, littleEndian, true)
  var neg = val & 0x80000000
  if (neg)
    return (0xffffffff - val + 1) * -1
  else
    return val
}

Buffer.prototype.readInt32LE = function (offset, noAssert) {
  return _readInt32(this, offset, true, noAssert)
}

Buffer.prototype.readInt32BE = function (offset, noAssert) {
  return _readInt32(this, offset, false, noAssert)
}

function _readFloat (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset + 3 < buf.length, 'Trying to read beyond buffer length')
  }

  return ieee754.read(buf, offset, littleEndian, 23, 4)
}

Buffer.prototype.readFloatLE = function (offset, noAssert) {
  return _readFloat(this, offset, true, noAssert)
}

Buffer.prototype.readFloatBE = function (offset, noAssert) {
  return _readFloat(this, offset, false, noAssert)
}

function _readDouble (buf, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset + 7 < buf.length, 'Trying to read beyond buffer length')
  }

  return ieee754.read(buf, offset, littleEndian, 52, 8)
}

Buffer.prototype.readDoubleLE = function (offset, noAssert) {
  return _readDouble(this, offset, true, noAssert)
}

Buffer.prototype.readDoubleBE = function (offset, noAssert) {
  return _readDouble(this, offset, false, noAssert)
}

Buffer.prototype.writeUInt8 = function (value, offset, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'trying to write beyond buffer length')
    verifuint(value, 0xff)
  }

  if (offset >= this.length) return

  this[offset] = value
}

function _writeUInt16 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'trying to write beyond buffer length')
    verifuint(value, 0xffff)
  }

  var len = buf.length
  if (offset >= len)
    return

  for (var i = 0, j = Math.min(len - offset, 2); i < j; i++) {
    buf[offset + i] =
        (value & (0xff << (8 * (littleEndian ? i : 1 - i)))) >>>
            (littleEndian ? i : 1 - i) * 8
  }
}

Buffer.prototype.writeUInt16LE = function (value, offset, noAssert) {
  _writeUInt16(this, value, offset, true, noAssert)
}

Buffer.prototype.writeUInt16BE = function (value, offset, noAssert) {
  _writeUInt16(this, value, offset, false, noAssert)
}

function _writeUInt32 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'trying to write beyond buffer length')
    verifuint(value, 0xffffffff)
  }

  var len = buf.length
  if (offset >= len)
    return

  for (var i = 0, j = Math.min(len - offset, 4); i < j; i++) {
    buf[offset + i] =
        (value >>> (littleEndian ? i : 3 - i) * 8) & 0xff
  }
}

Buffer.prototype.writeUInt32LE = function (value, offset, noAssert) {
  _writeUInt32(this, value, offset, true, noAssert)
}

Buffer.prototype.writeUInt32BE = function (value, offset, noAssert) {
  _writeUInt32(this, value, offset, false, noAssert)
}

Buffer.prototype.writeInt8 = function (value, offset, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset < this.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7f, -0x80)
  }

  if (offset >= this.length)
    return

  if (value >= 0)
    this.writeUInt8(value, offset, noAssert)
  else
    this.writeUInt8(0xff + value + 1, offset, noAssert)
}

function _writeInt16 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 1 < buf.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7fff, -0x8000)
  }

  var len = buf.length
  if (offset >= len)
    return

  if (value >= 0)
    _writeUInt16(buf, value, offset, littleEndian, noAssert)
  else
    _writeUInt16(buf, 0xffff + value + 1, offset, littleEndian, noAssert)
}

Buffer.prototype.writeInt16LE = function (value, offset, noAssert) {
  _writeInt16(this, value, offset, true, noAssert)
}

Buffer.prototype.writeInt16BE = function (value, offset, noAssert) {
  _writeInt16(this, value, offset, false, noAssert)
}

function _writeInt32 (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to write beyond buffer length')
    verifsint(value, 0x7fffffff, -0x80000000)
  }

  var len = buf.length
  if (offset >= len)
    return

  if (value >= 0)
    _writeUInt32(buf, value, offset, littleEndian, noAssert)
  else
    _writeUInt32(buf, 0xffffffff + value + 1, offset, littleEndian, noAssert)
}

Buffer.prototype.writeInt32LE = function (value, offset, noAssert) {
  _writeInt32(this, value, offset, true, noAssert)
}

Buffer.prototype.writeInt32BE = function (value, offset, noAssert) {
  _writeInt32(this, value, offset, false, noAssert)
}

function _writeFloat (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 3 < buf.length, 'Trying to write beyond buffer length')
    verifIEEE754(value, 3.4028234663852886e+38, -3.4028234663852886e+38)
  }

  var len = buf.length
  if (offset >= len)
    return

  ieee754.write(buf, value, offset, littleEndian, 23, 4)
}

Buffer.prototype.writeFloatLE = function (value, offset, noAssert) {
  _writeFloat(this, value, offset, true, noAssert)
}

Buffer.prototype.writeFloatBE = function (value, offset, noAssert) {
  _writeFloat(this, value, offset, false, noAssert)
}

function _writeDouble (buf, value, offset, littleEndian, noAssert) {
  if (!noAssert) {
    assert(value !== undefined && value !== null, 'missing value')
    assert(typeof littleEndian === 'boolean', 'missing or invalid endian')
    assert(offset !== undefined && offset !== null, 'missing offset')
    assert(offset + 7 < buf.length,
        'Trying to write beyond buffer length')
    verifIEEE754(value, 1.7976931348623157E+308, -1.7976931348623157E+308)
  }

  var len = buf.length
  if (offset >= len)
    return

  ieee754.write(buf, value, offset, littleEndian, 52, 8)
}

Buffer.prototype.writeDoubleLE = function (value, offset, noAssert) {
  _writeDouble(this, value, offset, true, noAssert)
}

Buffer.prototype.writeDoubleBE = function (value, offset, noAssert) {
  _writeDouble(this, value, offset, false, noAssert)
}

// fill(value, start=0, end=buffer.length)
Buffer.prototype.fill = function (value, start, end) {
  if (!value) value = 0
  if (!start) start = 0
  if (!end) end = this.length

  if (typeof value === 'string') {
    value = value.charCodeAt(0)
  }

  assert(typeof value === 'number' && !isNaN(value), 'value is not a number')
  assert(end >= start, 'end < start')

  // Fill 0 bytes; we're done
  if (end === start) return
  if (this.length === 0) return

  assert(start >= 0 && start < this.length, 'start out of bounds')
  assert(end >= 0 && end <= this.length, 'end out of bounds')

  for (var i = start; i < end; i++) {
    this[i] = value
  }
}

Buffer.prototype.inspect = function () {
  var out = []
  var len = this.length
  for (var i = 0; i < len; i++) {
    out[i] = toHex(this[i])
    if (i === exports.INSPECT_MAX_BYTES) {
      out[i + 1] = '...'
      break
    }
  }
  return '<Buffer ' + out.join(' ') + '>'
}

/**
 * Creates a new `ArrayBuffer` with the *copied* memory of the buffer instance.
 * Added in Node 0.12. Only available in browsers that support ArrayBuffer.
 */
Buffer.prototype.toArrayBuffer = function () {
  if (typeof Uint8Array !== 'undefined') {
    if (Buffer._useTypedArrays) {
      return (new Buffer(this)).buffer
    } else {
      var buf = new Uint8Array(this.length)
      for (var i = 0, len = buf.length; i < len; i += 1)
        buf[i] = this[i]
      return buf.buffer
    }
  } else {
    throw new Error('Buffer.toArrayBuffer not supported in this browser')
  }
}

// HELPER FUNCTIONS
// ================

function stringtrim (str) {
  if (str.trim) return str.trim()
  return str.replace(/^\s+|\s+$/g, '')
}

var BP = Buffer.prototype

/**
 * Augment a Uint8Array *instance* (not the Uint8Array class!) with Buffer methods
 */
Buffer._augment = function (arr) {
  arr._isBuffer = true

  // save reference to original Uint8Array get/set methods before overwriting
  arr._get = arr.get
  arr._set = arr.set

  // deprecated, will be removed in node 0.13+
  arr.get = BP.get
  arr.set = BP.set

  arr.write = BP.write
  arr.toString = BP.toString
  arr.toLocaleString = BP.toString
  arr.toJSON = BP.toJSON
  arr.copy = BP.copy
  arr.slice = BP.slice
  arr.readUInt8 = BP.readUInt8
  arr.readUInt16LE = BP.readUInt16LE
  arr.readUInt16BE = BP.readUInt16BE
  arr.readUInt32LE = BP.readUInt32LE
  arr.readUInt32BE = BP.readUInt32BE
  arr.readInt8 = BP.readInt8
  arr.readInt16LE = BP.readInt16LE
  arr.readInt16BE = BP.readInt16BE
  arr.readInt32LE = BP.readInt32LE
  arr.readInt32BE = BP.readInt32BE
  arr.readFloatLE = BP.readFloatLE
  arr.readFloatBE = BP.readFloatBE
  arr.readDoubleLE = BP.readDoubleLE
  arr.readDoubleBE = BP.readDoubleBE
  arr.writeUInt8 = BP.writeUInt8
  arr.writeUInt16LE = BP.writeUInt16LE
  arr.writeUInt16BE = BP.writeUInt16BE
  arr.writeUInt32LE = BP.writeUInt32LE
  arr.writeUInt32BE = BP.writeUInt32BE
  arr.writeInt8 = BP.writeInt8
  arr.writeInt16LE = BP.writeInt16LE
  arr.writeInt16BE = BP.writeInt16BE
  arr.writeInt32LE = BP.writeInt32LE
  arr.writeInt32BE = BP.writeInt32BE
  arr.writeFloatLE = BP.writeFloatLE
  arr.writeFloatBE = BP.writeFloatBE
  arr.writeDoubleLE = BP.writeDoubleLE
  arr.writeDoubleBE = BP.writeDoubleBE
  arr.fill = BP.fill
  arr.inspect = BP.inspect
  arr.toArrayBuffer = BP.toArrayBuffer

  return arr
}

// slice(start, end)
function clamp (index, len, defaultValue) {
  if (typeof index !== 'number') return defaultValue
  index = ~~index;  // Coerce to integer.
  if (index >= len) return len
  if (index >= 0) return index
  index += len
  if (index >= 0) return index
  return 0
}

function coerce (length) {
  // Coerce length to a number (possibly NaN), round up
  // in case it's fractional (e.g. 123.456) then do a
  // double negate to coerce a NaN to 0. Easy, right?
  length = ~~Math.ceil(+length)
  return length < 0 ? 0 : length
}

function isArray (subject) {
  return (Array.isArray || function (subject) {
    return Object.prototype.toString.call(subject) === '[object Array]'
  })(subject)
}

function isArrayish (subject) {
  return isArray(subject) || Buffer.isBuffer(subject) ||
      subject && typeof subject === 'object' &&
      typeof subject.length === 'number'
}

function toHex (n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function utf8ToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    var b = str.charCodeAt(i)
    if (b <= 0x7F)
      byteArray.push(str.charCodeAt(i))
    else {
      var start = i
      if (b >= 0xD800 && b <= 0xDFFF) i++
      var h = encodeURIComponent(str.slice(start, i+1)).substr(1).split('%')
      for (var j = 0; j < h.length; j++)
        byteArray.push(parseInt(h[j], 16))
    }
  }
  return byteArray
}

function asciiToBytes (str) {
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    // Node's code seems to be doing this and not & 0x7F..
    byteArray.push(str.charCodeAt(i) & 0xFF)
  }
  return byteArray
}

function utf16leToBytes (str) {
  var c, hi, lo
  var byteArray = []
  for (var i = 0; i < str.length; i++) {
    c = str.charCodeAt(i)
    hi = c >> 8
    lo = c % 256
    byteArray.push(lo)
    byteArray.push(hi)
  }

  return byteArray
}

function base64ToBytes (str) {
  return base64.toByteArray(str)
}

function blitBuffer (src, dst, offset, length) {
  var pos
  for (var i = 0; i < length; i++) {
    if ((i + offset >= dst.length) || (i >= src.length))
      break
    dst[i + offset] = src[i]
  }
  return i
}

function decodeUtf8Char (str) {
  try {
    return decodeURIComponent(str)
  } catch (err) {
    return String.fromCharCode(0xFFFD) // UTF 8 invalid char
  }
}

/*
 * We have to make sure that the value is a valid integer. This means that it
 * is non-negative. It has no fractional component and that it does not
 * exceed the maximum allowed value.
 */
function verifuint (value, max) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value >= 0, 'specified a negative value for writing an unsigned value')
  assert(value <= max, 'value is larger than maximum value for type')
  assert(Math.floor(value) === value, 'value has a fractional component')
}

function verifsint (value, max, min) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value <= max, 'value larger than maximum allowed value')
  assert(value >= min, 'value smaller than minimum allowed value')
  assert(Math.floor(value) === value, 'value has a fractional component')
}

function verifIEEE754 (value, max, min) {
  assert(typeof value === 'number', 'cannot write a non-number as a number')
  assert(value <= max, 'value larger than maximum allowed value')
  assert(value >= min, 'value smaller than minimum allowed value')
}

function assert (test, message) {
  if (!test) throw new Error(message || 'Failed assertion')
}

},{"base64-js":173,"ieee754":174}],173:[function(require,module,exports){
var lookup = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

;(function (exports) {
	'use strict';

  var Arr = (typeof Uint8Array !== 'undefined')
    ? Uint8Array
    : Array

	var PLUS   = '+'.charCodeAt(0)
	var SLASH  = '/'.charCodeAt(0)
	var NUMBER = '0'.charCodeAt(0)
	var LOWER  = 'a'.charCodeAt(0)
	var UPPER  = 'A'.charCodeAt(0)
	var PLUS_URL_SAFE = '-'.charCodeAt(0)
	var SLASH_URL_SAFE = '_'.charCodeAt(0)

	function decode (elt) {
		var code = elt.charCodeAt(0)
		if (code === PLUS ||
		    code === PLUS_URL_SAFE)
			return 62 // '+'
		if (code === SLASH ||
		    code === SLASH_URL_SAFE)
			return 63 // '/'
		if (code < NUMBER)
			return -1 //no match
		if (code < NUMBER + 10)
			return code - NUMBER + 26 + 26
		if (code < UPPER + 26)
			return code - UPPER
		if (code < LOWER + 26)
			return code - LOWER + 26
	}

	function b64ToByteArray (b64) {
		var i, j, l, tmp, placeHolders, arr

		if (b64.length % 4 > 0) {
			throw new Error('Invalid string. Length must be a multiple of 4')
		}

		// the number of equal signs (place holders)
		// if there are two placeholders, than the two characters before it
		// represent one byte
		// if there is only one, then the three characters before it represent 2 bytes
		// this is just a cheap hack to not do indexOf twice
		var len = b64.length
		placeHolders = '=' === b64.charAt(len - 2) ? 2 : '=' === b64.charAt(len - 1) ? 1 : 0

		// base64 is 4/3 + up to two characters of the original data
		arr = new Arr(b64.length * 3 / 4 - placeHolders)

		// if there are placeholders, only get up to the last complete 4 chars
		l = placeHolders > 0 ? b64.length - 4 : b64.length

		var L = 0

		function push (v) {
			arr[L++] = v
		}

		for (i = 0, j = 0; i < l; i += 4, j += 3) {
			tmp = (decode(b64.charAt(i)) << 18) | (decode(b64.charAt(i + 1)) << 12) | (decode(b64.charAt(i + 2)) << 6) | decode(b64.charAt(i + 3))
			push((tmp & 0xFF0000) >> 16)
			push((tmp & 0xFF00) >> 8)
			push(tmp & 0xFF)
		}

		if (placeHolders === 2) {
			tmp = (decode(b64.charAt(i)) << 2) | (decode(b64.charAt(i + 1)) >> 4)
			push(tmp & 0xFF)
		} else if (placeHolders === 1) {
			tmp = (decode(b64.charAt(i)) << 10) | (decode(b64.charAt(i + 1)) << 4) | (decode(b64.charAt(i + 2)) >> 2)
			push((tmp >> 8) & 0xFF)
			push(tmp & 0xFF)
		}

		return arr
	}

	function uint8ToBase64 (uint8) {
		var i,
			extraBytes = uint8.length % 3, // if we have 1 byte left, pad 2 bytes
			output = "",
			temp, length

		function encode (num) {
			return lookup.charAt(num)
		}

		function tripletToBase64 (num) {
			return encode(num >> 18 & 0x3F) + encode(num >> 12 & 0x3F) + encode(num >> 6 & 0x3F) + encode(num & 0x3F)
		}

		// go through the array every three bytes, we'll deal with trailing stuff later
		for (i = 0, length = uint8.length - extraBytes; i < length; i += 3) {
			temp = (uint8[i] << 16) + (uint8[i + 1] << 8) + (uint8[i + 2])
			output += tripletToBase64(temp)
		}

		// pad the end with zeros, but make sure to not forget the extra bytes
		switch (extraBytes) {
			case 1:
				temp = uint8[uint8.length - 1]
				output += encode(temp >> 2)
				output += encode((temp << 4) & 0x3F)
				output += '=='
				break
			case 2:
				temp = (uint8[uint8.length - 2] << 8) + (uint8[uint8.length - 1])
				output += encode(temp >> 10)
				output += encode((temp >> 4) & 0x3F)
				output += encode((temp << 2) & 0x3F)
				output += '='
				break
		}

		return output
	}

	exports.toByteArray = b64ToByteArray
	exports.fromByteArray = uint8ToBase64
}(typeof exports === 'undefined' ? (this.base64js = {}) : exports))

},{}],174:[function(require,module,exports){
exports.read = function (buffer, offset, isLE, mLen, nBytes) {
  var e, m
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var nBits = -7
  var i = isLE ? (nBytes - 1) : 0
  var d = isLE ? -1 : 1
  var s = buffer[offset + i]

  i += d

  e = s & ((1 << (-nBits)) - 1)
  s >>= (-nBits)
  nBits += eLen
  for (; nBits > 0; e = e * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  m = e & ((1 << (-nBits)) - 1)
  e >>= (-nBits)
  nBits += mLen
  for (; nBits > 0; m = m * 256 + buffer[offset + i], i += d, nBits -= 8) {}

  if (e === 0) {
    e = 1 - eBias
  } else if (e === eMax) {
    return m ? NaN : ((s ? -1 : 1) * Infinity)
  } else {
    m = m + Math.pow(2, mLen)
    e = e - eBias
  }
  return (s ? -1 : 1) * m * Math.pow(2, e - mLen)
}

exports.write = function (buffer, value, offset, isLE, mLen, nBytes) {
  var e, m, c
  var eLen = nBytes * 8 - mLen - 1
  var eMax = (1 << eLen) - 1
  var eBias = eMax >> 1
  var rt = (mLen === 23 ? Math.pow(2, -24) - Math.pow(2, -77) : 0)
  var i = isLE ? 0 : (nBytes - 1)
  var d = isLE ? 1 : -1
  var s = value < 0 || (value === 0 && 1 / value < 0) ? 1 : 0

  value = Math.abs(value)

  if (isNaN(value) || value === Infinity) {
    m = isNaN(value) ? 1 : 0
    e = eMax
  } else {
    e = Math.floor(Math.log(value) / Math.LN2)
    if (value * (c = Math.pow(2, -e)) < 1) {
      e--
      c *= 2
    }
    if (e + eBias >= 1) {
      value += rt / c
    } else {
      value += rt * Math.pow(2, 1 - eBias)
    }
    if (value * c >= 2) {
      e++
      c /= 2
    }

    if (e + eBias >= eMax) {
      m = 0
      e = eMax
    } else if (e + eBias >= 1) {
      m = (value * c - 1) * Math.pow(2, mLen)
      e = e + eBias
    } else {
      m = value * Math.pow(2, eBias - 1) * Math.pow(2, mLen)
      e = 0
    }
  }

  for (; mLen >= 8; buffer[offset + i] = m & 0xff, i += d, m /= 256, mLen -= 8) {}

  e = (e << mLen) | m
  eLen += mLen
  for (; eLen > 0; buffer[offset + i] = e & 0xff, i += d, e /= 256, eLen -= 8) {}

  buffer[offset + i - d] |= s * 128
}

},{}],175:[function(require,module,exports){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

function EventEmitter() {
  this._events = this._events || {};
  this._maxListeners = this._maxListeners || undefined;
}
module.exports = EventEmitter;

// Backwards-compat with node 0.10.x
EventEmitter.EventEmitter = EventEmitter;

EventEmitter.prototype._events = undefined;
EventEmitter.prototype._maxListeners = undefined;

// By default EventEmitters will print a warning if more than 10 listeners are
// added to it. This is a useful default which helps finding memory leaks.
EventEmitter.defaultMaxListeners = 10;

// Obviously not all Emitters should be limited to 10. This function allows
// that to be increased. Set to zero for unlimited.
EventEmitter.prototype.setMaxListeners = function(n) {
  if (!isNumber(n) || n < 0 || isNaN(n))
    throw TypeError('n must be a positive number');
  this._maxListeners = n;
  return this;
};

EventEmitter.prototype.emit = function(type) {
  var er, handler, len, args, i, listeners;

  if (!this._events)
    this._events = {};

  // If there is no 'error' event listener then throw.
  if (type === 'error') {
    if (!this._events.error ||
        (isObject(this._events.error) && !this._events.error.length)) {
      er = arguments[1];
      if (er instanceof Error) {
        throw er; // Unhandled 'error' event
      }
      throw TypeError('Uncaught, unspecified "error" event.');
    }
  }

  handler = this._events[type];

  if (isUndefined(handler))
    return false;

  if (isFunction(handler)) {
    switch (arguments.length) {
      // fast cases
      case 1:
        handler.call(this);
        break;
      case 2:
        handler.call(this, arguments[1]);
        break;
      case 3:
        handler.call(this, arguments[1], arguments[2]);
        break;
      // slower
      default:
        len = arguments.length;
        args = new Array(len - 1);
        for (i = 1; i < len; i++)
          args[i - 1] = arguments[i];
        handler.apply(this, args);
    }
  } else if (isObject(handler)) {
    len = arguments.length;
    args = new Array(len - 1);
    for (i = 1; i < len; i++)
      args[i - 1] = arguments[i];

    listeners = handler.slice();
    len = listeners.length;
    for (i = 0; i < len; i++)
      listeners[i].apply(this, args);
  }

  return true;
};

EventEmitter.prototype.addListener = function(type, listener) {
  var m;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events)
    this._events = {};

  // To avoid recursion in the case that type === "newListener"! Before
  // adding it to the listeners, first emit "newListener".
  if (this._events.newListener)
    this.emit('newListener', type,
              isFunction(listener.listener) ?
              listener.listener : listener);

  if (!this._events[type])
    // Optimize the case of one listener. Don't need the extra array object.
    this._events[type] = listener;
  else if (isObject(this._events[type]))
    // If we've already got an array, just append.
    this._events[type].push(listener);
  else
    // Adding the second element, need to change to array.
    this._events[type] = [this._events[type], listener];

  // Check for listener leak
  if (isObject(this._events[type]) && !this._events[type].warned) {
    var m;
    if (!isUndefined(this._maxListeners)) {
      m = this._maxListeners;
    } else {
      m = EventEmitter.defaultMaxListeners;
    }

    if (m && m > 0 && this._events[type].length > m) {
      this._events[type].warned = true;
      console.error('(node) warning: possible EventEmitter memory ' +
                    'leak detected. %d listeners added. ' +
                    'Use emitter.setMaxListeners() to increase limit.',
                    this._events[type].length);
      if (typeof console.trace === 'function') {
        // not supported in IE 10
        console.trace();
      }
    }
  }

  return this;
};

EventEmitter.prototype.on = EventEmitter.prototype.addListener;

EventEmitter.prototype.once = function(type, listener) {
  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  var fired = false;

  function g() {
    this.removeListener(type, g);

    if (!fired) {
      fired = true;
      listener.apply(this, arguments);
    }
  }

  g.listener = listener;
  this.on(type, g);

  return this;
};

// emits a 'removeListener' event iff the listener was removed
EventEmitter.prototype.removeListener = function(type, listener) {
  var list, position, length, i;

  if (!isFunction(listener))
    throw TypeError('listener must be a function');

  if (!this._events || !this._events[type])
    return this;

  list = this._events[type];
  length = list.length;
  position = -1;

  if (list === listener ||
      (isFunction(list.listener) && list.listener === listener)) {
    delete this._events[type];
    if (this._events.removeListener)
      this.emit('removeListener', type, listener);

  } else if (isObject(list)) {
    for (i = length; i-- > 0;) {
      if (list[i] === listener ||
          (list[i].listener && list[i].listener === listener)) {
        position = i;
        break;
      }
    }

    if (position < 0)
      return this;

    if (list.length === 1) {
      list.length = 0;
      delete this._events[type];
    } else {
      list.splice(position, 1);
    }

    if (this._events.removeListener)
      this.emit('removeListener', type, listener);
  }

  return this;
};

EventEmitter.prototype.removeAllListeners = function(type) {
  var key, listeners;

  if (!this._events)
    return this;

  // not listening for removeListener, no need to emit
  if (!this._events.removeListener) {
    if (arguments.length === 0)
      this._events = {};
    else if (this._events[type])
      delete this._events[type];
    return this;
  }

  // emit removeListener for all listeners on all events
  if (arguments.length === 0) {
    for (key in this._events) {
      if (key === 'removeListener') continue;
      this.removeAllListeners(key);
    }
    this.removeAllListeners('removeListener');
    this._events = {};
    return this;
  }

  listeners = this._events[type];

  if (isFunction(listeners)) {
    this.removeListener(type, listeners);
  } else {
    // LIFO order
    while (listeners.length)
      this.removeListener(type, listeners[listeners.length - 1]);
  }
  delete this._events[type];

  return this;
};

EventEmitter.prototype.listeners = function(type) {
  var ret;
  if (!this._events || !this._events[type])
    ret = [];
  else if (isFunction(this._events[type]))
    ret = [this._events[type]];
  else
    ret = this._events[type].slice();
  return ret;
};

EventEmitter.listenerCount = function(emitter, type) {
  var ret;
  if (!emitter._events || !emitter._events[type])
    ret = 0;
  else if (isFunction(emitter._events[type]))
    ret = 1;
  else
    ret = emitter._events[type].length;
  return ret;
};

function isFunction(arg) {
  return typeof arg === 'function';
}

function isNumber(arg) {
  return typeof arg === 'number';
}

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}

function isUndefined(arg) {
  return arg === void 0;
}

},{}],176:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};

process.nextTick = (function () {
    var canSetImmediate = typeof window !== 'undefined'
    && window.setImmediate;
    var canPost = typeof window !== 'undefined'
    && window.postMessage && window.addEventListener
    ;

    if (canSetImmediate) {
        return function (f) { return window.setImmediate(f) };
    }

    if (canPost) {
        var queue = [];
        window.addEventListener('message', function (ev) {
            var source = ev.source;
            if ((source === window || source === null) && ev.data === 'process-tick') {
                ev.stopPropagation();
                if (queue.length > 0) {
                    var fn = queue.shift();
                    fn();
                }
            }
        }, true);

        return function nextTick(fn) {
            queue.push(fn);
            window.postMessage('process-tick', '*');
        };
    }

    return function nextTick(fn) {
        setTimeout(fn, 0);
    };
})();

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
}

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};

},{}],177:[function(require,module,exports){
/**
 * Actions that modify the URL.
 */
var LocationActions = {

  /**
   * Indicates a new location is being pushed to the history stack.
   */
  PUSH: 'push',

  /**
   * Indicates the current location should be replaced.
   */
  REPLACE: 'replace',

  /**
   * Indicates the most recent entry should be removed from the history stack.
   */
  POP: 'pop'

};

module.exports = LocationActions;

},{}],178:[function(require,module,exports){
var LocationActions = require('../actions/LocationActions');

/**
 * A scroll behavior that attempts to imitate the default behavior
 * of modern browsers.
 */
var ImitateBrowserBehavior = {

  updateScrollPosition: function (position, actionType) {
    switch (actionType) {
      case LocationActions.PUSH:
      case LocationActions.REPLACE:
        window.scrollTo(0, 0);
        break;
      case LocationActions.POP:
        if (position) {
          window.scrollTo(position.x, position.y);
        } else {
          window.scrollTo(0, 0);
        }
        break;
    }
  }

};

module.exports = ImitateBrowserBehavior;

},{"../actions/LocationActions":177}],179:[function(require,module,exports){
/**
 * A scroll behavior that always scrolls to the top of the page
 * after a transition.
 */
var ScrollToTopBehavior = {

  updateScrollPosition: function () {
    window.scrollTo(0, 0);
  }

};

module.exports = ScrollToTopBehavior;

},{}],180:[function(require,module,exports){
var React = require('react');
var FakeNode = require('../mixins/FakeNode');
var PropTypes = require('../utils/PropTypes');

/**
 * A <DefaultRoute> component is a special kind of <Route> that
 * renders when its parent matches but none of its siblings do.
 * Only one such route may be used at any given level in the
 * route hierarchy.
 */
var DefaultRoute = React.createClass({

  displayName: 'DefaultRoute',

  mixins: [ FakeNode ],

  propTypes: {
    name: React.PropTypes.string,
    path: PropTypes.falsy,
    handler: React.PropTypes.func.isRequired
  }

});

module.exports = DefaultRoute;

},{"../mixins/FakeNode":190,"../utils/PropTypes":201,"react":366}],181:[function(require,module,exports){
var React = require('react');
var classSet = require('react/lib/cx');
var assign = require('react/lib/Object.assign');
var Navigation = require('../mixins/Navigation');
var State = require('../mixins/State');

function isLeftClickEvent(event) {
  return event.button === 0;
}

function isModifiedEvent(event) {
  return !!(event.metaKey || event.altKey || event.ctrlKey || event.shiftKey);
}

/**
 * <Link> components are used to create an <a> element that links to a route.
 * When that route is active, the link gets an "active" class name (or the
 * value of its `activeClassName` prop).
 *
 * For example, assuming you have the following route:
 *
 *   <Route name="showPost" path="/posts/:postID" handler={Post}/>
 *
 * You could use the following component to link to that route:
 *
 *   <Link to="showPost" params={{ postID: "123" }} />
 *
 * In addition to params, links may pass along query string parameters
 * using the `query` prop.
 *
 *   <Link to="showPost" params={{ postID: "123" }} query={{ show:true }}/>
 */
var Link = React.createClass({

  displayName: 'Link',

  mixins: [ Navigation, State ],

  propTypes: {
    activeClassName: React.PropTypes.string.isRequired,
    to: React.PropTypes.string.isRequired,
    params: React.PropTypes.object,
    query: React.PropTypes.object,
    onClick: React.PropTypes.func
  },

  getDefaultProps: function () {
    return {
      activeClassName: 'active'
    };
  },

  handleClick: function (event) {
    var allowTransition = true;
    var clickResult;

    if (this.props.onClick)
      clickResult = this.props.onClick(event);

    if (isModifiedEvent(event) || !isLeftClickEvent(event))
      return;

    if (clickResult === false || event.defaultPrevented === true)
      allowTransition = false;

    event.preventDefault();

    if (allowTransition)
      this.transitionTo(this.props.to, this.props.params, this.props.query);
  },

  /**
   * Returns the value of the "href" attribute to use on the DOM element.
   */
  getHref: function () {
    return this.makeHref(this.props.to, this.props.params, this.props.query);
  },

  /**
   * Returns the value of the "class" attribute to use on the DOM element, which contains
   * the value of the activeClassName property when this <Link> is active.
   */
  getClassName: function () {
    var classNames = {};

    if (this.props.className)
      classNames[this.props.className] = true;

    if (this.isActive(this.props.to, this.props.params, this.props.query))
      classNames[this.props.activeClassName] = true;

    return classSet(classNames);
  },

  render: function () {
    var props = assign({}, this.props, {
      href: this.getHref(),
      className: this.getClassName(),
      onClick: this.handleClick
    });

    return React.DOM.a(props, this.props.children);
  }

});

module.exports = Link;

},{"../mixins/Navigation":191,"../mixins/State":195,"react":366,"react/lib/Object.assign":245,"react/lib/cx":324}],182:[function(require,module,exports){
var React = require('react');
var FakeNode = require('../mixins/FakeNode');
var PropTypes = require('../utils/PropTypes');

/**
 * A <NotFoundRoute> is a special kind of <Route> that
 * renders when the beginning of its parent's path matches
 * but none of its siblings do, including any <DefaultRoute>.
 * Only one such route may be used at any given level in the
 * route hierarchy.
 */
var NotFoundRoute = React.createClass({

  displayName: 'NotFoundRoute',

  mixins: [ FakeNode ],

  propTypes: {
    name: React.PropTypes.string,
    path: PropTypes.falsy,
    handler: React.PropTypes.func.isRequired
  }

});

module.exports = NotFoundRoute;

},{"../mixins/FakeNode":190,"../utils/PropTypes":201,"react":366}],183:[function(require,module,exports){
var React = require('react');
var FakeNode = require('../mixins/FakeNode');
var PropTypes = require('../utils/PropTypes');

/**
 * A <Redirect> component is a special kind of <Route> that always
 * redirects to another route when it matches.
 */
var Redirect = React.createClass({

  displayName: 'Redirect',

  mixins: [ FakeNode ],

  propTypes: {
    path: React.PropTypes.string,
    from: React.PropTypes.string, // Alias for path.
    to: React.PropTypes.string,
    handler: PropTypes.falsy
  }

});

module.exports = Redirect;

},{"../mixins/FakeNode":190,"../utils/PropTypes":201,"react":366}],184:[function(require,module,exports){
var React = require('react');
var FakeNode = require('../mixins/FakeNode');

/**
 * <Route> components specify components that are rendered to the page when the
 * URL matches a given pattern.
 *
 * Routes are arranged in a nested tree structure. When a new URL is requested,
 * the tree is searched depth-first to find a route whose path matches the URL.
 * When one is found, all routes in the tree that lead to it are considered
 * "active" and their components are rendered into the DOM, nested in the same
 * order as they are in the tree.
 *
 * The preferred way to configure a router is using JSX. The XML-like syntax is
 * a great way to visualize how routes are laid out in an application.
 *
 *   var routes = [
 *     <Route handler={App}>
 *       <Route name="login" handler={Login}/>
 *       <Route name="logout" handler={Logout}/>
 *       <Route name="about" handler={About}/>
 *     </Route>
 *   ];
 *   
 *   Router.run(routes, function (Handler) {
 *     React.render(<Handler/>, document.body);
 *   });
 *
 * Handlers for Route components that contain children can render their active
 * child route using a <RouteHandler> element.
 *
 *   var App = React.createClass({
 *     render: function () {
 *       return (
 *         <div class="application">
 *           <RouteHandler/>
 *         </div>
 *       );
 *     }
 *   });
 */
var Route = React.createClass({

  displayName: 'Route',

  mixins: [ FakeNode ],

  propTypes: {
    name: React.PropTypes.string,
    path: React.PropTypes.string,
    handler: React.PropTypes.func.isRequired,
    ignoreScrollBehavior: React.PropTypes.bool
  }

});

module.exports = Route;

},{"../mixins/FakeNode":190,"react":366}],185:[function(require,module,exports){
var React = require('react');
var RouteHandlerMixin = require('../mixins/RouteHandler');

/**
 * A <RouteHandler> component renders the active child route handler
 * when routes are nested.
 */
var RouteHandler = React.createClass({

  displayName: 'RouteHandler',

  mixins: [RouteHandlerMixin],

  getDefaultProps: function () {
    return {
      ref: '__routeHandler__'
    };
  },

  render: function () {
    return this.getRouteHandler();
  }

});

module.exports = RouteHandler;

},{"../mixins/RouteHandler":193,"react":366}],186:[function(require,module,exports){
exports.DefaultRoute = require('./components/DefaultRoute');
exports.Link = require('./components/Link');
exports.NotFoundRoute = require('./components/NotFoundRoute');
exports.Redirect = require('./components/Redirect');
exports.Route = require('./components/Route');
exports.RouteHandler = require('./components/RouteHandler');

exports.HashLocation = require('./locations/HashLocation');
exports.HistoryLocation = require('./locations/HistoryLocation');
exports.RefreshLocation = require('./locations/RefreshLocation');

exports.ImitateBrowserBehavior = require('./behaviors/ImitateBrowserBehavior');
exports.ScrollToTopBehavior = require('./behaviors/ScrollToTopBehavior');

exports.Navigation = require('./mixins/Navigation');
exports.State = require('./mixins/State');

exports.create = require('./utils/createRouter');
exports.run = require('./utils/runRouter');

exports.History = require('./utils/History');

},{"./behaviors/ImitateBrowserBehavior":178,"./behaviors/ScrollToTopBehavior":179,"./components/DefaultRoute":180,"./components/Link":181,"./components/NotFoundRoute":182,"./components/Redirect":183,"./components/Route":184,"./components/RouteHandler":185,"./locations/HashLocation":187,"./locations/HistoryLocation":188,"./locations/RefreshLocation":189,"./mixins/Navigation":191,"./mixins/State":195,"./utils/History":198,"./utils/createRouter":204,"./utils/runRouter":208}],187:[function(require,module,exports){
var LocationActions = require('../actions/LocationActions');
var History = require('../utils/History');
var Path = require('../utils/Path');

/**
 * Returns the current URL path from the `hash` portion of the URL, including
 * query string.
 */
function getHashPath() {
  return Path.decode(
    // We can't use window.location.hash here because it's not
    // consistent across browsers - Firefox will pre-decode it!
    window.location.href.split('#')[1] || ''
  );
}

var _actionType;

function ensureSlash() {
  var path = getHashPath();

  if (path.charAt(0) === '/')
    return true;

  HashLocation.replace('/' + path);

  return false;
}

var _changeListeners = [];

function notifyChange(type) {
  if (type === LocationActions.PUSH)
    History.length += 1;

  var change = {
    path: getHashPath(),
    type: type
  };

  _changeListeners.forEach(function (listener) {
    listener(change);
  });
}

var _isListening = false;

function onHashChange() {
  if (ensureSlash()) {
    // If we don't have an _actionType then all we know is the hash
    // changed. It was probably caused by the user clicking the Back
    // button, but may have also been the Forward button or manual
    // manipulation. So just guess 'pop'.
    notifyChange(_actionType || LocationActions.POP);
    _actionType = null;
  }
}

/**
 * A Location that uses `window.location.hash`.
 */
var HashLocation = {

  addChangeListener: function (listener) {
    _changeListeners.push(listener);

    // Do this BEFORE listening for hashchange.
    ensureSlash();

    if (_isListening)
      return;

    if (window.addEventListener) {
      window.addEventListener('hashchange', onHashChange, false);
    } else {
      window.attachEvent('onhashchange', onHashChange);
    }

    _isListening = true;
  },

  removeChangeListener: function(listener) {
    for (var i = 0, l = _changeListeners.length; i < l; i ++) {
      if (_changeListeners[i] === listener) {
        _changeListeners.splice(i, 1);
        break;
      }
    }

    if (window.removeEventListener) {
      window.removeEventListener('hashchange', onHashChange, false);
    } else {
      window.removeEvent('onhashchange', onHashChange);
    }

    if (_changeListeners.length === 0)
      _isListening = false;
  },



  push: function (path) {
    _actionType = LocationActions.PUSH;
    window.location.hash = Path.encode(path);
  },

  replace: function (path) {
    _actionType = LocationActions.REPLACE;
    window.location.replace(window.location.pathname + '#' + Path.encode(path));
  },

  pop: function () {
    _actionType = LocationActions.POP;
    History.back();
  },

  getCurrentPath: getHashPath,

  toString: function () {
    return '<HashLocation>';
  }

};

module.exports = HashLocation;

},{"../actions/LocationActions":177,"../utils/History":198,"../utils/Path":199}],188:[function(require,module,exports){
var LocationActions = require('../actions/LocationActions');
var History = require('../utils/History');
var Path = require('../utils/Path');

/**
 * Returns the current URL path from `window.location`, including query string.
 */
function getWindowPath() {
  return Path.decode(
    window.location.pathname + window.location.search
  );
}

var _changeListeners = [];

function notifyChange(type) {
  var change = {
    path: getWindowPath(),
    type: type
  };

  _changeListeners.forEach(function (listener) {
    listener(change);
  });
}

var _isListening = false;

function onPopState() {
  notifyChange(LocationActions.POP);
}

/**
 * A Location that uses HTML5 history.
 */
var HistoryLocation = {

  addChangeListener: function (listener) {
    _changeListeners.push(listener);

    if (_isListening)
      return;

    if (window.addEventListener) {
      window.addEventListener('popstate', onPopState, false);
    } else {
      window.attachEvent('popstate', onPopState);
    }

    _isListening = true;
  },

  removeChangeListener: function(listener) {
    for (var i = 0, l = _changeListeners.length; i < l; i ++) {
      if (_changeListeners[i] === listener) {
        _changeListeners.splice(i, 1);
        break;
      }
    }

    if (window.addEventListener) {
      window.removeEventListener('popstate', onPopState);
    } else {
      window.removeEvent('popstate', onPopState);
    }

    if (_changeListeners.length === 0)
      _isListening = false;
  },



  push: function (path) {
    window.history.pushState({ path: path }, '', Path.encode(path));
    History.length += 1;
    notifyChange(LocationActions.PUSH);
  },

  replace: function (path) {
    window.history.replaceState({ path: path }, '', Path.encode(path));
    notifyChange(LocationActions.REPLACE);
  },

  pop: History.back,

  getCurrentPath: getWindowPath,

  toString: function () {
    return '<HistoryLocation>';
  }

};

module.exports = HistoryLocation;

},{"../actions/LocationActions":177,"../utils/History":198,"../utils/Path":199}],189:[function(require,module,exports){
var HistoryLocation = require('./HistoryLocation');
var History = require('../utils/History');
var Path = require('../utils/Path');

/**
 * A Location that uses full page refreshes. This is used as
 * the fallback for HistoryLocation in browsers that do not
 * support the HTML5 history API.
 */
var RefreshLocation = {

  push: function (path) {
    window.location = Path.encode(path);
  },

  replace: function (path) {
    window.location.replace(Path.encode(path));
  },

  pop: History.back,

  getCurrentPath: HistoryLocation.getCurrentPath,

  toString: function () {
    return '<RefreshLocation>';
  }

};

module.exports = RefreshLocation;

},{"../utils/History":198,"../utils/Path":199,"./HistoryLocation":188}],190:[function(require,module,exports){
var invariant = require('react/lib/invariant');

var FakeNode = {

  render: function () {
    invariant(
      false,
      '%s elements should not be rendered',
      this.constructor.displayName
    );
  }

};

module.exports = FakeNode;

},{"react/lib/invariant":346}],191:[function(require,module,exports){
var React = require('react');

/**
 * A mixin for components that modify the URL.
 *
 * Example:
 *
 *   var MyLink = React.createClass({
 *     mixins: [ Router.Navigation ],
 *     handleClick: function (event) {
 *       event.preventDefault();
 *       this.transitionTo('aRoute', { the: 'params' }, { the: 'query' });
 *     },
 *     render: function () {
 *       return (
 *         <a onClick={this.handleClick}>Click me!</a>
 *       );
 *     }
 *   });
 */
var Navigation = {

  contextTypes: {
    makePath: React.PropTypes.func.isRequired,
    makeHref: React.PropTypes.func.isRequired,
    transitionTo: React.PropTypes.func.isRequired,
    replaceWith: React.PropTypes.func.isRequired,
    goBack: React.PropTypes.func.isRequired
  },

  /**
   * Returns an absolute URL path created from the given route
   * name, URL parameters, and query values.
   */
  makePath: function (to, params, query) {
    return this.context.makePath(to, params, query);
  },

  /**
   * Returns a string that may safely be used as the href of a
   * link to the route with the given name.
   */
  makeHref: function (to, params, query) {
    return this.context.makeHref(to, params, query);
  },

  /**
   * Transitions to the URL specified in the arguments by pushing
   * a new URL onto the history stack.
   */
  transitionTo: function (to, params, query) {
    this.context.transitionTo(to, params, query);
  },

  /**
   * Transitions to the URL specified in the arguments by replacing
   * the current URL in the history stack.
   */
  replaceWith: function (to, params, query) {
    this.context.replaceWith(to, params, query);
  },

  /**
   * Transitions to the previous URL.
   */
  goBack: function () {
    this.context.goBack();
  }

};

module.exports = Navigation;

},{"react":366}],192:[function(require,module,exports){
var React = require('react');

/**
 * Provides the router with context for Router.Navigation.
 */
var NavigationContext = {

  childContextTypes: {
    makePath: React.PropTypes.func.isRequired,
    makeHref: React.PropTypes.func.isRequired,
    transitionTo: React.PropTypes.func.isRequired,
    replaceWith: React.PropTypes.func.isRequired,
    goBack: React.PropTypes.func.isRequired
  },

  getChildContext: function () {
    return {
      makePath: this.constructor.makePath,
      makeHref: this.constructor.makeHref,
      transitionTo: this.constructor.transitionTo,
      replaceWith: this.constructor.replaceWith,
      goBack: this.constructor.goBack
    };
  }

};

module.exports = NavigationContext;

},{"react":366}],193:[function(require,module,exports){
var React = require('react');

module.exports = {
  contextTypes: {
    getRouteAtDepth: React.PropTypes.func.isRequired,
    getRouteComponents: React.PropTypes.func.isRequired,
    routeHandlers: React.PropTypes.array.isRequired
  },

  childContextTypes: {
    routeHandlers: React.PropTypes.array.isRequired
  },

  getChildContext: function () {
    return {
      routeHandlers: this.context.routeHandlers.concat([ this ])
    };
  },

  getRouteDepth: function () {
    return this.context.routeHandlers.length - 1;
  },

  componentDidMount: function () {
    this._updateRouteComponent();
  },

  componentDidUpdate: function () {
    this._updateRouteComponent();
  },

  _updateRouteComponent: function () {
    var depth = this.getRouteDepth();
    var components = this.context.getRouteComponents();
    components[depth] = this.refs[this.props.ref || '__routeHandler__'];
  },

  getRouteHandler: function (props) {
    var route = this.context.getRouteAtDepth(this.getRouteDepth());
    return route ? React.createElement(route.handler, props || this.props) : null;
  }
};
},{"react":366}],194:[function(require,module,exports){
var invariant = require('react/lib/invariant');
var canUseDOM = require('react/lib/ExecutionEnvironment').canUseDOM;
var getWindowScrollPosition = require('../utils/getWindowScrollPosition');

function shouldUpdateScroll(state, prevState) {
  if (!prevState)
    return true;

  // Don't update scroll position when only the query has changed.
  if (state.pathname === prevState.pathname)
    return false;

  var routes = state.routes;
  var prevRoutes = prevState.routes;

  var sharedAncestorRoutes = routes.filter(function (route) {
    return prevRoutes.indexOf(route) !== -1;
  });

  return !sharedAncestorRoutes.some(function (route) {
    return route.ignoreScrollBehavior;
  });
}

/**
 * Provides the router with the ability to manage window scroll position
 * according to its scroll behavior.
 */
var Scrolling = {

  statics: {
    /**
     * Records curent scroll position as the last known position for the given URL path.
     */
    recordScrollPosition: function (path) {
      if (!this.scrollHistory)
        this.scrollHistory = {};

      this.scrollHistory[path] = getWindowScrollPosition();
    },

    /**
     * Returns the last known scroll position for the given URL path.
     */
    getScrollPosition: function (path) {
      if (!this.scrollHistory)
        this.scrollHistory = {};

      return this.scrollHistory[path] || null;
    }
  },

  componentWillMount: function () {
    invariant(
      this.getScrollBehavior() == null || canUseDOM,
      'Cannot use scroll behavior without a DOM'
    );
  },

  componentDidMount: function () {
    this._updateScroll();
  },

  componentDidUpdate: function (prevProps, prevState) {
    this._updateScroll(prevState);
  },

  _updateScroll: function (prevState) {
    if (!shouldUpdateScroll(this.state, prevState))
      return;

    var scrollBehavior = this.getScrollBehavior();

    if (scrollBehavior)
      scrollBehavior.updateScrollPosition(
        this.constructor.getScrollPosition(this.state.path),
        this.state.action
      );
  }

};

module.exports = Scrolling;

},{"../utils/getWindowScrollPosition":206,"react/lib/ExecutionEnvironment":240,"react/lib/invariant":346}],195:[function(require,module,exports){
var React = require('react');

/**
 * A mixin for components that need to know the path, routes, URL
 * params and query that are currently active.
 *
 * Example:
 *
 *   var AboutLink = React.createClass({
 *     mixins: [ Router.State ],
 *     render: function () {
 *       var className = this.props.className;
 *   
 *       if (this.isActive('about'))
 *         className += ' is-active';
 *   
 *       return React.DOM.a({ className: className }, this.props.children);
 *     }
 *   });
 */
var State = {

  contextTypes: {
    getCurrentPath: React.PropTypes.func.isRequired,
    getCurrentRoutes: React.PropTypes.func.isRequired,
    getCurrentPathname: React.PropTypes.func.isRequired,
    getCurrentParams: React.PropTypes.func.isRequired,
    getCurrentQuery: React.PropTypes.func.isRequired,
    isActive: React.PropTypes.func.isRequired
  },

  /**
   * Returns the current URL path.
   */
  getPath: function () {
    return this.context.getCurrentPath();
  },

  /**
   * Returns an array of the routes that are currently active.
   */
  getRoutes: function () {
    return this.context.getCurrentRoutes();
  },

  /**
   * Returns the current URL path without the query string.
   */
  getPathname: function () {
    return this.context.getCurrentPathname();
  },

  /**
   * Returns an object of the URL params that are currently active.
   */
  getParams: function () {
    return this.context.getCurrentParams();
  },

  /**
   * Returns an object of the query params that are currently active.
   */
  getQuery: function () {
    return this.context.getCurrentQuery();
  },

  /**
   * A helper method to determine if a given route, params, and query
   * are active.
   */
  isActive: function (to, params, query) {
    return this.context.isActive(to, params, query);
  }

};

module.exports = State;

},{"react":366}],196:[function(require,module,exports){
var React = require('react');
var assign = require('react/lib/Object.assign');
var Path = require('../utils/Path');

function routeIsActive(activeRoutes, routeName) {
  return activeRoutes.some(function (route) {
    return route.name === routeName;
  });
}

function paramsAreActive(activeParams, params) {
  for (var property in params)
    if (String(activeParams[property]) !== String(params[property]))
      return false;

  return true;
}

function queryIsActive(activeQuery, query) {
  for (var property in query)
    if (String(activeQuery[property]) !== String(query[property]))
      return false;

  return true;
}

/**
 * Provides the router with context for Router.State.
 */
var StateContext = {

  /**
   * Returns the current URL path + query string.
   */
  getCurrentPath: function () {
    return this.state.path;
  },

  /**
   * Returns a read-only array of the currently active routes.
   */
  getCurrentRoutes: function () {
    return this.state.routes.slice(0);
  },

  /**
   * Returns the current URL path without the query string.
   */
  getCurrentPathname: function () {
    return this.state.pathname;
  },

  /**
   * Returns a read-only object of the currently active URL parameters.
   */
  getCurrentParams: function () {
    return assign({}, this.state.params);
  },

  /**
   * Returns a read-only object of the currently active query parameters.
   */
  getCurrentQuery: function () {
    return assign({}, this.state.query);
  },

  /**
   * Returns true if the given route, params, and query are active.
   */
  isActive: function (to, params, query) {
    if (Path.isAbsolute(to))
      return to === this.state.path;

    return routeIsActive(this.state.routes, to) &&
      paramsAreActive(this.state.params, params) &&
      (query == null || queryIsActive(this.state.query, query));
  },

  childContextTypes: {
    getCurrentPath: React.PropTypes.func.isRequired,
    getCurrentRoutes: React.PropTypes.func.isRequired,
    getCurrentPathname: React.PropTypes.func.isRequired,
    getCurrentParams: React.PropTypes.func.isRequired,
    getCurrentQuery: React.PropTypes.func.isRequired,
    isActive: React.PropTypes.func.isRequired
  },

  getChildContext: function () {
    return {
      getCurrentPath: this.getCurrentPath,
      getCurrentRoutes: this.getCurrentRoutes,
      getCurrentPathname: this.getCurrentPathname,
      getCurrentParams: this.getCurrentParams,
      getCurrentQuery: this.getCurrentQuery,
      isActive: this.isActive
    };
  }

};

module.exports = StateContext;

},{"../utils/Path":199,"react":366,"react/lib/Object.assign":245}],197:[function(require,module,exports){
/**
 * Represents a cancellation caused by navigating away
 * before the previous transition has fully resolved.
 */
function Cancellation() { }

module.exports = Cancellation;

},{}],198:[function(require,module,exports){
var invariant = require('react/lib/invariant');
var canUseDOM = require('react/lib/ExecutionEnvironment').canUseDOM;

var History = {

  /**
   * Sends the browser back one entry in the history.
   */
  back: function () {
    invariant(
      canUseDOM,
      'Cannot use History.back without a DOM'
    );

    // Do this first so that History.length will
    // be accurate in location change listeners.
    History.length -= 1;

    window.history.back();
  },

  /**
   * The current number of entries in the history.
   */
  length: 1

};

module.exports = History;

},{"react/lib/ExecutionEnvironment":240,"react/lib/invariant":346}],199:[function(require,module,exports){
var invariant = require('react/lib/invariant');
var merge = require('qs/lib/utils').merge;
var qs = require('qs');

var paramCompileMatcher = /:([a-zA-Z_$][a-zA-Z0-9_$]*)|[*.()\[\]\\+|{}^$]/g;
var paramInjectMatcher = /:([a-zA-Z_$][a-zA-Z0-9_$?]*[?]?)|[*]/g;
var paramInjectTrailingSlashMatcher = /\/\/\?|\/\?/g;
var queryMatcher = /\?(.+)/;

var _compiledPatterns = {};

function compilePattern(pattern) {
  if (!(pattern in _compiledPatterns)) {
    var paramNames = [];
    var source = pattern.replace(paramCompileMatcher, function (match, paramName) {
      if (paramName) {
        paramNames.push(paramName);
        return '([^/?#]+)';
      } else if (match === '*') {
        paramNames.push('splat');
        return '(.*?)';
      } else {
        return '\\' + match;
      }
    });

    _compiledPatterns[pattern] = {
      matcher: new RegExp('^' + source + '$', 'i'),
      paramNames: paramNames
    };
  }

  return _compiledPatterns[pattern];
}

var Path = {

  /**
   * Safely decodes special characters in the given URL path.
   */
  decode: function (path) {
    return decodeURI(path.replace(/\+/g, ' '));
  },

  /**
   * Safely encodes special characters in the given URL path.
   */
  encode: function (path) {
    return encodeURI(path).replace(/%20/g, '+');
  },

  /**
   * Returns an array of the names of all parameters in the given pattern.
   */
  extractParamNames: function (pattern) {
    return compilePattern(pattern).paramNames;
  },

  /**
   * Extracts the portions of the given URL path that match the given pattern
   * and returns an object of param name => value pairs. Returns null if the
   * pattern does not match the given path.
   */
  extractParams: function (pattern, path) {
    var object = compilePattern(pattern);
    var match = path.match(object.matcher);

    if (!match)
      return null;

    var params = {};

    object.paramNames.forEach(function (paramName, index) {
      params[paramName] = match[index + 1];
    });

    return params;
  },

  /**
   * Returns a version of the given route path with params interpolated. Throws
   * if there is a dynamic segment of the route path for which there is no param.
   */
  injectParams: function (pattern, params) {
    params = params || {};

    var splatIndex = 0;

    return pattern.replace(paramInjectMatcher, function (match, paramName) {
      paramName = paramName || 'splat';

      // If param is optional don't check for existence
      if (paramName.slice(-1) !== '?') {
        invariant(
          params[paramName] != null,
          'Missing "' + paramName + '" parameter for path "' + pattern + '"'
        );
      } else {
        paramName = paramName.slice(0, -1);

        if (params[paramName] == null)
          return '';
      }

      var segment;
      if (paramName === 'splat' && Array.isArray(params[paramName])) {
        segment = params[paramName][splatIndex++];

        invariant(
          segment != null,
          'Missing splat # ' + splatIndex + ' for path "' + pattern + '"'
        );
      } else {
        segment = params[paramName];
      }

      return segment;
    }).replace(paramInjectTrailingSlashMatcher, '/');
  },

  /**
   * Returns an object that is the result of parsing any query string contained
   * in the given path, null if the path contains no query string.
   */
  extractQuery: function (path) {
    var match = path.match(queryMatcher);
    return match && qs.parse(match[1]);
  },

  /**
   * Returns a version of the given path without the query string.
   */
  withoutQuery: function (path) {
    return path.replace(queryMatcher, '');
  },

  /**
   * Returns a version of the given path with the parameters in the given
   * query merged into the query string.
   */
  withQuery: function (path, query) {
    var existingQuery = Path.extractQuery(path);

    if (existingQuery)
      query = query ? merge(existingQuery, query) : existingQuery;

    var queryString = query && qs.stringify(query);

    if (queryString)
      return Path.withoutQuery(path) + '?' + queryString;

    return path;
  },

  /**
   * Returns true if the given path is absolute.
   */
  isAbsolute: function (path) {
    return path.charAt(0) === '/';
  },

  /**
   * Returns a normalized version of the given path.
   */
  normalize: function (path, parentRoute) {
    return path.replace(/^\/*/, '/');
  },

  /**
   * Joins two URL paths together.
   */
  join: function (a, b) {
    return a.replace(/\/*$/, '/') + b;
  }

};

module.exports = Path;

},{"qs":210,"qs/lib/utils":214,"react/lib/invariant":346}],200:[function(require,module,exports){
var Promise = require('when/lib/Promise');

// TODO: Use process.env.NODE_ENV check + envify to enable
// when's promise monitor here when in dev.

module.exports = Promise;

},{"when/lib/Promise":215}],201:[function(require,module,exports){
var PropTypes = {

  /**
   * Requires that the value of a prop be falsy.
   */
  falsy: function (props, propName, componentName) {
    if (props[propName])
      return new Error('<' + componentName + '> may not have a "' + propName + '" prop');
  }

};

module.exports = PropTypes;

},{}],202:[function(require,module,exports){
/**
 * Encapsulates a redirect to the given route.
 */
function Redirect(to, params, query) {
  this.to = to;
  this.params = params;
  this.query = query;
}

module.exports = Redirect;

},{}],203:[function(require,module,exports){
var assign = require('react/lib/Object.assign');
var reversedArray = require('./reversedArray');
var Redirect = require('./Redirect');
var Promise = require('./Promise');

/**
 * Runs all hook functions serially and calls callback(error) when finished.
 * A hook may return a promise if it needs to execute asynchronously.
 */
function runHooks(hooks, callback) {
  var promise;
  try {
    promise = hooks.reduce(function (promise, hook) {
      // The first hook to use transition.wait makes the rest
      // of the transition async from that point forward.
      return promise ? promise.then(hook) : hook();
    }, null);
  } catch (error) {
    return callback(error); // Sync error.
  }

  if (promise) {
    // Use setTimeout to break the promise chain.
    promise.then(function () {
      setTimeout(callback);
    }, function (error) {
      setTimeout(function () {
        callback(error);
      });
    });
  } else {
    callback();
  }
}

/**
 * Calls the willTransitionFrom hook of all handlers in the given matches
 * serially in reverse with the transition object and the current instance of
 * the route's handler, so that the deepest nested handlers are called first.
 * Calls callback(error) when finished.
 */
function runTransitionFromHooks(transition, routes, components, callback) {
  components = reversedArray(components);

  var hooks = reversedArray(routes).map(function (route, index) {
    return function () {
      var handler = route.handler;

      if (!transition.isAborted && handler.willTransitionFrom)
        return handler.willTransitionFrom(transition, components[index]);

      var promise = transition._promise;
      transition._promise = null;

      return promise;
    };
  });

  runHooks(hooks, callback);
}

/**
 * Calls the willTransitionTo hook of all handlers in the given matches
 * serially with the transition object and any params that apply to that
 * handler. Calls callback(error) when finished.
 */
function runTransitionToHooks(transition, routes, params, query, callback) {
  var hooks = routes.map(function (route) {
    return function () {
      var handler = route.handler;

      if (!transition.isAborted && handler.willTransitionTo)
        handler.willTransitionTo(transition, params, query);

      var promise = transition._promise;
      transition._promise = null;

      return promise;
    };
  });

  runHooks(hooks, callback);
}

/**
 * Encapsulates a transition to a given path.
 *
 * The willTransitionTo and willTransitionFrom handlers receive
 * an instance of this class as their first argument.
 */
function Transition(path, retry) {
  this.path = path;
  this.abortReason = null;
  this.isAborted = false;
  this.retry = retry.bind(this);
  this._promise = null;
}

assign(Transition.prototype, {

  abort: function (reason) {
    if (this.isAborted) {
      // First abort wins.
      return;
    }

    this.abortReason = reason;
    this.isAborted = true;
  },

  redirect: function (to, params, query) {
    this.abort(new Redirect(to, params, query));
  },

  wait: function (value) {
    this._promise = Promise.resolve(value);
  },

  from: function (routes, components, callback) {
    return runTransitionFromHooks(this, routes, components, callback);
  },

  to: function (routes, params, query, callback) {
    return runTransitionToHooks(this, routes, params, query, callback);
  }

});

module.exports = Transition;

},{"./Promise":200,"./Redirect":202,"./reversedArray":207,"react/lib/Object.assign":245}],204:[function(require,module,exports){
(function (process){
/* jshint -W058 */
var React = require('react');
var warning = require('react/lib/warning');
var invariant = require('react/lib/invariant');
var canUseDOM = require('react/lib/ExecutionEnvironment').canUseDOM;
var ImitateBrowserBehavior = require('../behaviors/ImitateBrowserBehavior');
var RouteHandler = require('../components/RouteHandler');
var LocationActions = require('../actions/LocationActions');
var HashLocation = require('../locations/HashLocation');
var HistoryLocation = require('../locations/HistoryLocation');
var RefreshLocation = require('../locations/RefreshLocation');
var NavigationContext = require('../mixins/NavigationContext');
var StateContext = require('../mixins/StateContext');
var Scrolling = require('../mixins/Scrolling');
var createRoutesFromChildren = require('./createRoutesFromChildren');
var supportsHistory = require('./supportsHistory');
var Transition = require('./Transition');
var PropTypes = require('./PropTypes');
var Redirect = require('./Redirect');
var History = require('./History');
var Cancellation = require('./Cancellation');
var Path = require('./Path');

/**
 * The default location for new routers.
 */
var DEFAULT_LOCATION = canUseDOM ? HashLocation : '/';

/**
 * The default scroll behavior for new routers.
 */
var DEFAULT_SCROLL_BEHAVIOR = canUseDOM ? ImitateBrowserBehavior : null;

/**
 * The default error handler for new routers.
 */
function defaultErrorHandler(error) {
  // Throw so we don't silently swallow async errors.
  throw error; // This error probably originated in a transition hook.
}

/**
 * The default aborted transition handler for new routers.
 */
function defaultAbortHandler(abortReason, location) {
  if (typeof location === 'string')
    throw new Error('Unhandled aborted transition! Reason: ' + abortReason);

  if (abortReason instanceof Cancellation) {
    return;
  } else if (abortReason instanceof Redirect) {
    location.replace(this.makePath(abortReason.to, abortReason.params, abortReason.query));
  } else {
    location.pop();
  }
}

function findMatch(pathname, routes, defaultRoute, notFoundRoute) {
  var match, route, params;

  for (var i = 0, len = routes.length; i < len; ++i) {
    route = routes[i];

    // Check the subtree first to find the most deeply-nested match.
    match = findMatch(pathname, route.childRoutes, route.defaultRoute, route.notFoundRoute);

    if (match != null) {
      match.routes.unshift(route);
      return match;
    }

    // No routes in the subtree matched, so check this route.
    params = Path.extractParams(route.path, pathname);

    if (params)
      return createMatch(route, params);
  }

  // No routes matched, so try the default route if there is one.
  if (defaultRoute && (params = Path.extractParams(defaultRoute.path, pathname)))
    return createMatch(defaultRoute, params);

  // Last attempt: does the "not found" route match?
  if (notFoundRoute && (params = Path.extractParams(notFoundRoute.path, pathname)))
    return createMatch(notFoundRoute, params);

  return match;
}

function createMatch(route, params) {
  return { routes: [ route ], params: params };
}

function hasProperties(object, properties) {
  for (var propertyName in properties)
    if (properties.hasOwnProperty(propertyName) && object[propertyName] !== properties[propertyName])
      return false;

  return true;
}

function hasMatch(routes, route, prevParams, nextParams, prevQuery, nextQuery) {
  return routes.some(function (r) {
    if (r !== route)
      return false;

    var paramNames = route.paramNames;
    var paramName;

    // Ensure that all params the route cares about did not change.
    for (var i = 0, len = paramNames.length; i < len; ++i) {
      paramName = paramNames[i];

      if (nextParams[paramName] !== prevParams[paramName])
        return false;
    }

    // Ensure the query hasn't changed.
    return hasProperties(prevQuery, nextQuery) && hasProperties(nextQuery, prevQuery);
  });
}

/**
 * Creates and returns a new router using the given options. A router
 * is a ReactComponent class that knows how to react to changes in the
 * URL and keep the contents of the page in sync.
 *
 * Options may be any of the following:
 *
 * - routes           (required) The route config
 * - location         The location to use. Defaults to HashLocation when
 *                    the DOM is available, "/" otherwise
 * - scrollBehavior   The scroll behavior to use. Defaults to ImitateBrowserBehavior
 *                    when the DOM is available, null otherwise
 * - onError          A function that is used to handle errors
 * - onAbort          A function that is used to handle aborted transitions
 *
 * When rendering in a server-side environment, the location should simply
 * be the URL path that was used in the request, including the query string.
 */
function createRouter(options) {
  options = options || {};

  if (typeof options === 'function') {
    options = { routes: options }; // Router.create(<Route>)
  } else if (Array.isArray(options)) {
    options = { routes: options }; // Router.create([ <Route>, <Route> ])
  }

  var routes = [];
  var namedRoutes = {};
  var components = [];
  var location = options.location || DEFAULT_LOCATION;
  var scrollBehavior = options.scrollBehavior || DEFAULT_SCROLL_BEHAVIOR;
  var onError = options.onError || defaultErrorHandler;
  var onAbort = options.onAbort || defaultAbortHandler;
  var state = {};
  var nextState = {};
  var pendingTransition = null;

  function updateState() {
    state = nextState;
    nextState = {};
  }

  if (typeof location === 'string') {
    warning(
      !canUseDOM || process.env.NODE_ENV === 'test',
      'You should not use a static location in a DOM environment because ' +
      'the router will not be kept in sync with the current URL'
    );
  } else {
    invariant(
      canUseDOM,
      'You cannot use %s without a DOM',
      location
    );
  }

  // Automatically fall back to full page refreshes in
  // browsers that don't support the HTML history API.
  if (location === HistoryLocation && !supportsHistory())
    location = RefreshLocation;

  var router = React.createClass({

    displayName: 'Router',

    mixins: [ NavigationContext, StateContext, Scrolling ],

    statics: {

      defaultRoute: null,
      notFoundRoute: null,

      /**
       * Adds routes to this router from the given children object (see ReactChildren).
       */
      addRoutes: function (children) {
        routes.push.apply(routes, createRoutesFromChildren(children, this, namedRoutes));
      },

      /**
       * Returns an absolute URL path created from the given route
       * name, URL parameters, and query.
       */
      makePath: function (to, params, query) {
        var path;
        if (Path.isAbsolute(to)) {
          path = Path.normalize(to);
        } else {
          var route = namedRoutes[to];

          invariant(
            route,
            'Unable to find <Route name="%s">',
            to
          );

          path = route.path;
        }

        return Path.withQuery(Path.injectParams(path, params), query);
      },

      /**
       * Returns a string that may safely be used as the href of a link
       * to the route with the given name, URL parameters, and query.
       */
      makeHref: function (to, params, query) {
        var path = this.makePath(to, params, query);
        return (location === HashLocation) ? '#' + path : path;
      },

      /**
       * Transitions to the URL specified in the arguments by pushing
       * a new URL onto the history stack.
       */
      transitionTo: function (to, params, query) {
        invariant(
          typeof location !== 'string',
          'You cannot use transitionTo with a static location'
        );

        var path = this.makePath(to, params, query);

        if (pendingTransition) {
          // Replace so pending location does not stay in history.
          location.replace(path);
        } else {
          location.push(path);
        }
      },

      /**
       * Transitions to the URL specified in the arguments by replacing
       * the current URL in the history stack.
       */
      replaceWith: function (to, params, query) {
        invariant(
          typeof location !== 'string',
          'You cannot use replaceWith with a static location'
        );

        location.replace(this.makePath(to, params, query));
      },

      /**
       * Transitions to the previous URL if one is available. Returns true if the
       * router was able to go back, false otherwise.
       *
       * Note: The router only tracks history entries in your application, not the
       * current browser session, so you can safely call this function without guarding
       * against sending the user back to some other site. However, when using
       * RefreshLocation (which is the fallback for HistoryLocation in browsers that
       * don't support HTML5 history) this method will *always* send the client back
       * because we cannot reliably track history length.
       */
      goBack: function () {
        invariant(
          typeof location !== 'string',
          'You cannot use goBack with a static location'
        );

        if (History.length > 1 || location === RefreshLocation) {
          location.pop();
          return true;
        }

        warning(false, 'goBack() was ignored because there is no router history');

        return false;
      },

      /**
       * Performs a match of the given pathname against this router and returns an object
       * with the { routes, params } that match. Returns null if no match can be made.
       */
      match: function (pathname) {
        return findMatch(pathname, routes, this.defaultRoute, this.notFoundRoute) || null;
      },

      /**
       * Performs a transition to the given path and calls callback(error, abortReason)
       * when the transition is finished. If both arguments are null the router's state
       * was updated. Otherwise the transition did not complete.
       *
       * In a transition, a router first determines which routes are involved by beginning
       * with the current route, up the route tree to the first parent route that is shared
       * with the destination route, and back down the tree to the destination route. The
       * willTransitionFrom hook is invoked on all route handlers we're transitioning away
       * from, in reverse nesting order. Likewise, the willTransitionTo hook is invoked on
       * all route handlers we're transitioning to.
       *
       * Both willTransitionFrom and willTransitionTo hooks may either abort or redirect the
       * transition. To resolve asynchronously, they may use transition.wait(promise). If no
       * hooks wait, the transition is fully synchronous.
       */
      dispatch: function (path, action, callback) {
        if (pendingTransition) {
          pendingTransition.abort(new Cancellation);
          pendingTransition = null;
        }

        var prevPath = state.path;
        if (prevPath === path)
          return; // Nothing to do!

        // Record the scroll position as early as possible to
        // get it before browsers try update it automatically.
        if (prevPath && action !== LocationActions.REPLACE)
          this.recordScrollPosition(prevPath);

        var pathname = Path.withoutQuery(path);
        var match = this.match(pathname);

        warning(
          match != null,
          'No route matches path "%s". Make sure you have <Route path="%s"> somewhere in your routes',
          path, path
        );

        if (match == null)
          match = {};

        var prevRoutes = state.routes || [];
        var prevParams = state.params || {};
        var prevQuery = state.query || {};

        var nextRoutes = match.routes || [];
        var nextParams = match.params || {};
        var nextQuery = Path.extractQuery(path) || {};

        var fromRoutes, toRoutes;
        if (prevRoutes.length) {
          fromRoutes = prevRoutes.filter(function (route) {
            return !hasMatch(nextRoutes, route, prevParams, nextParams, prevQuery, nextQuery);
          });

          toRoutes = nextRoutes.filter(function (route) {
            return !hasMatch(prevRoutes, route, prevParams, nextParams, prevQuery, nextQuery);
          });
        } else {
          fromRoutes = [];
          toRoutes = nextRoutes;
        }

        var transition = new Transition(path, this.replaceWith.bind(this, path));
        pendingTransition = transition;

        transition.from(fromRoutes, components, function (error) {
          if (error || transition.isAborted)
            return callback.call(router, error, transition);

          transition.to(toRoutes, nextParams, nextQuery, function (error) {
            if (error || transition.isAborted)
              return callback.call(router, error, transition);

            nextState.path = path;
            nextState.action = action;
            nextState.pathname = pathname;
            nextState.routes = nextRoutes;
            nextState.params = nextParams;
            nextState.query = nextQuery;

            callback.call(router, null, transition);
          });
        });
      },

      /**
       * Starts this router and calls callback(router, state) when the route changes.
       *
       * If the router's location is static (i.e. a URL path in a server environment)
       * the callback is called only once. Otherwise, the location should be one of the
       * Router.*Location objects (e.g. Router.HashLocation or Router.HistoryLocation).
       */
      run: function (callback) {
        var dispatchHandler = function (error, transition) {
          pendingTransition = null;

          if (error) {
            onError.call(router, error);
          } else if (transition.isAborted) {
            onAbort.call(router, transition.abortReason, location);
          } else {
            callback.call(router, router, nextState);
          }
        };

        if (typeof location === 'string') {
          router.dispatch(location, null, dispatchHandler);
        } else {
          // Listen for changes to the location.
          var changeListener = function (change) {
            router.dispatch(change.path, change.type, dispatchHandler);
          };

          if (location.addChangeListener)
            location.addChangeListener(changeListener);

          // Bootstrap using the current path.
          router.dispatch(location.getCurrentPath(), null, dispatchHandler);
        }
      },

      teardown: function() {
        location.removeChangeListener(this.changeListener);
      }

    },

    propTypes: {
      children: PropTypes.falsy
    },

    getLocation: function () {
      return location;
    },

    getScrollBehavior: function () {
      return scrollBehavior;
    },

    getRouteAtDepth: function (depth) {
      var routes = this.state.routes;
      return routes && routes[depth];
    },

    getRouteComponents: function () {
      return components;
    },

    getInitialState: function () {
      updateState();
      return state;
    },

    componentWillReceiveProps: function () {
      updateState();
      this.setState(state);
    },

    componentWillUnmount: function() {
      router.teardown();
    },

    render: function () {
      return this.getRouteAtDepth(0) ? React.createElement(RouteHandler, this.props) : null;
    },

    childContextTypes: {
      getRouteAtDepth: React.PropTypes.func.isRequired,
      getRouteComponents: React.PropTypes.func.isRequired,
      routeHandlers: React.PropTypes.array.isRequired
    },

    getChildContext: function () {
      return {
        getRouteComponents: this.getRouteComponents,
        getRouteAtDepth: this.getRouteAtDepth,
        routeHandlers: [ this ]
      };
    }

  });

  if (options.routes)
    router.addRoutes(options.routes);

  return router;
}

module.exports = createRouter;

}).call(this,require("ngpmcQ"))
},{"../actions/LocationActions":177,"../behaviors/ImitateBrowserBehavior":178,"../components/RouteHandler":185,"../locations/HashLocation":187,"../locations/HistoryLocation":188,"../locations/RefreshLocation":189,"../mixins/NavigationContext":192,"../mixins/Scrolling":194,"../mixins/StateContext":196,"./Cancellation":197,"./History":198,"./Path":199,"./PropTypes":201,"./Redirect":202,"./Transition":203,"./createRoutesFromChildren":205,"./supportsHistory":209,"ngpmcQ":176,"react":366,"react/lib/ExecutionEnvironment":240,"react/lib/invariant":346,"react/lib/warning":365}],205:[function(require,module,exports){
/* jshint -W084 */
var React = require('react');
var warning = require('react/lib/warning');
var invariant = require('react/lib/invariant');
var DefaultRoute = require('../components/DefaultRoute');
var NotFoundRoute = require('../components/NotFoundRoute');
var Redirect = require('../components/Redirect');
var Route = require('../components/Route');
var Path = require('./Path');

var CONFIG_ELEMENT_TYPES = [
  DefaultRoute.type,
  NotFoundRoute.type,
  Redirect.type,
  Route.type
];

function createRedirectHandler(to, _params, _query) {
  return React.createClass({
    statics: {
      willTransitionTo: function (transition, params, query) {
        transition.redirect(to, _params || params, _query || query);
      }
    },

    render: function () {
      return null;
    }
  });
}

function checkPropTypes(componentName, propTypes, props) {
  for (var propName in propTypes) {
    if (propTypes.hasOwnProperty(propName)) {
      var error = propTypes[propName](props, propName, componentName);

      if (error instanceof Error)
        warning(false, error.message);
    }
  }
}

function createRoute(element, parentRoute, namedRoutes) {
  var type = element.type;
  var props = element.props;
  var componentName = (type && type.displayName) || 'UnknownComponent';

  invariant(
    CONFIG_ELEMENT_TYPES.indexOf(type) !== -1,
    'Unrecognized route configuration element "<%s>"',
    componentName
  );

  if (type.propTypes)
    checkPropTypes(componentName, type.propTypes, props);

  var route = { name: props.name };

  if (props.ignoreScrollBehavior) {
    route.ignoreScrollBehavior = true;
  }

  if (type === Redirect.type) {
    route.handler = createRedirectHandler(props.to, props.params, props.query);
    props.path = props.path || props.from || '*';
  } else {
    route.handler = props.handler;
  }

  var parentPath = (parentRoute && parentRoute.path) || '/';

  if ((props.path || props.name) && type !== DefaultRoute.type && type !== NotFoundRoute.type) {
    var path = props.path || props.name;

    // Relative paths extend their parent.
    if (!Path.isAbsolute(path))
      path = Path.join(parentPath, path);

    route.path = Path.normalize(path);
  } else {
    route.path = parentPath;

    if (type === NotFoundRoute.type)
      route.path += '*';
  }

  route.paramNames = Path.extractParamNames(route.path);

  // Make sure the route's path has all params its parent needs.
  if (parentRoute && Array.isArray(parentRoute.paramNames)) {
    parentRoute.paramNames.forEach(function (paramName) {
      invariant(
        route.paramNames.indexOf(paramName) !== -1,
        'The nested route path "%s" is missing the "%s" parameter of its parent path "%s"',
        route.path, paramName, parentRoute.path
      );
    });
  }

  // Make sure the route can be looked up by <Link>s.
  if (props.name) {
    invariant(
      namedRoutes[props.name] == null,
      'You cannot use the name "%s" for more than one route',
      props.name
    );

    namedRoutes[props.name] = route;
  }

  // Handle <NotFoundRoute>.
  if (type === NotFoundRoute.type) {
    invariant(
      parentRoute,
      '<NotFoundRoute> must have a parent <Route>'
    );

    invariant(
      parentRoute.notFoundRoute == null,
      'You may not have more than one <NotFoundRoute> per <Route>'
    );

    parentRoute.notFoundRoute = route;

    return null;
  }

  // Handle <DefaultRoute>.
  if (type === DefaultRoute.type) {
    invariant(
      parentRoute,
      '<DefaultRoute> must have a parent <Route>'
    );

    invariant(
      parentRoute.defaultRoute == null,
      'You may not have more than one <DefaultRoute> per <Route>'
    );

    parentRoute.defaultRoute = route;

    return null;
  }

  route.childRoutes = createRoutesFromChildren(props.children, route, namedRoutes);

  return route;
}

/**
 * Creates and returns an array of route objects from the given ReactChildren.
 */
function createRoutesFromChildren(children, parentRoute, namedRoutes) {
  var routes = [];

  React.Children.forEach(children, function (child) {
    // Exclude <DefaultRoute>s and <NotFoundRoute>s.
    if (child = createRoute(child, parentRoute, namedRoutes))
      routes.push(child);
  });

  return routes;
}

module.exports = createRoutesFromChildren;

},{"../components/DefaultRoute":180,"../components/NotFoundRoute":182,"../components/Redirect":183,"../components/Route":184,"./Path":199,"react":366,"react/lib/invariant":346,"react/lib/warning":365}],206:[function(require,module,exports){
var invariant = require('react/lib/invariant');
var canUseDOM = require('react/lib/ExecutionEnvironment').canUseDOM;

/**
 * Returns the current scroll position of the window as { x, y }.
 */
function getWindowScrollPosition() {
  invariant(
    canUseDOM,
    'Cannot get current scroll position without a DOM'
  );

  return {
    x: window.pageXOffset || document.documentElement.scrollLeft,
    y: window.pageYOffset || document.documentElement.scrollTop
  };
}

module.exports = getWindowScrollPosition;

},{"react/lib/ExecutionEnvironment":240,"react/lib/invariant":346}],207:[function(require,module,exports){
function reversedArray(array) {
  return array.slice(0).reverse();
}

module.exports = reversedArray;

},{}],208:[function(require,module,exports){
var createRouter = require('./createRouter');

/**
 * A high-level convenience method that creates, configures, and
 * runs a router in one shot. The method signature is:
 *
 *   Router.run(routes[, location ], callback);
 *
 * Using `window.location.hash` to manage the URL, you could do:
 *
 *   Router.run(routes, function (Handler) {
 *     React.render(<Handler/>, document.body);
 *   });
 * 
 * Using HTML5 history and a custom "cursor" prop:
 * 
 *   Router.run(routes, Router.HistoryLocation, function (Handler) {
 *     React.render(<Handler cursor={cursor}/>, document.body);
 *   });
 *
 * Returns the newly created router.
 *
 * Note: If you need to specify further options for your router such
 * as error/abort handling or custom scroll behavior, use Router.create
 * instead.
 *
 *   var router = Router.create(options);
 *   router.run(function (Handler) {
 *     // ...
 *   });
 */
function runRouter(routes, location, callback) {
  if (typeof location === 'function') {
    callback = location;
    location = null;
  }

  var router = createRouter({
    routes: routes,
    location: location
  });

  router.run(callback);

  return router;
}

module.exports = runRouter;

},{"./createRouter":204}],209:[function(require,module,exports){
function supportsHistory() {
  /*! taken from modernizr
   * https://github.com/Modernizr/Modernizr/blob/master/LICENSE
   * https://github.com/Modernizr/Modernizr/blob/master/feature-detects/history.js
   * changed to avoid false negatives for Windows Phones: https://github.com/rackt/react-router/issues/586
   */
  var ua = navigator.userAgent;
  if ((ua.indexOf('Android 2.') !== -1 ||
      (ua.indexOf('Android 4.0') !== -1)) &&
      ua.indexOf('Mobile Safari') !== -1 &&
      ua.indexOf('Chrome') === -1 &&
      ua.indexOf('Windows Phone') === -1) {
    return false;
  }
  return (window.history && 'pushState' in window.history);
}

module.exports = supportsHistory;

},{}],210:[function(require,module,exports){
module.exports = require('./lib');

},{"./lib":211}],211:[function(require,module,exports){
// Load modules

var Stringify = require('./stringify');
var Parse = require('./parse');


// Declare internals

var internals = {};


module.exports = {
    stringify: Stringify,
    parse: Parse
};

},{"./parse":212,"./stringify":213}],212:[function(require,module,exports){
// Load modules

var Utils = require('./utils');


// Declare internals

var internals = {
    delimiter: '&',
    depth: 5,
    arrayLimit: 20,
    parameterLimit: 1000
};


internals.parseValues = function (str, options) {

    var obj = {};
    var parts = str.split(options.delimiter, options.parameterLimit === Infinity ? undefined : options.parameterLimit);

    for (var i = 0, il = parts.length; i < il; ++i) {
        var part = parts[i];
        var pos = part.indexOf(']=') === -1 ? part.indexOf('=') : part.indexOf(']=') + 1;

        if (pos === -1) {
            obj[Utils.decode(part)] = '';
        }
        else {
            var key = Utils.decode(part.slice(0, pos));
            var val = Utils.decode(part.slice(pos + 1));

            if (!obj[key]) {
                obj[key] = val;
            }
            else {
                obj[key] = [].concat(obj[key]).concat(val);
            }
        }
    }

    return obj;
};


internals.parseObject = function (chain, val, options) {

    if (!chain.length) {
        return val;
    }

    var root = chain.shift();

    var obj = {};
    if (root === '[]') {
        obj = [];
        obj = obj.concat(internals.parseObject(chain, val, options));
    }
    else {
        var cleanRoot = root[0] === '[' && root[root.length - 1] === ']' ? root.slice(1, root.length - 1) : root;
        var index = parseInt(cleanRoot, 10);
        if (!isNaN(index) &&
            root !== cleanRoot &&
            index <= options.arrayLimit) {

            obj = [];
            obj[index] = internals.parseObject(chain, val, options);
        }
        else {
            obj[cleanRoot] = internals.parseObject(chain, val, options);
        }
    }

    return obj;
};


internals.parseKeys = function (key, val, options) {

    if (!key) {
        return;
    }

    // The regex chunks

    var parent = /^([^\[\]]*)/;
    var child = /(\[[^\[\]]*\])/g;

    // Get the parent

    var segment = parent.exec(key);

    // Don't allow them to overwrite object prototype properties

    if (Object.prototype.hasOwnProperty(segment[1])) {
        return;
    }

    // Stash the parent if it exists

    var keys = [];
    if (segment[1]) {
        keys.push(segment[1]);
    }

    // Loop through children appending to the array until we hit depth

    var i = 0;
    while ((segment = child.exec(key)) !== null && i < options.depth) {

        ++i;
        if (!Object.prototype.hasOwnProperty(segment[1].replace(/\[|\]/g, ''))) {
            keys.push(segment[1]);
        }
    }

    // If there's a remainder, just add whatever is left

    if (segment) {
        keys.push('[' + key.slice(segment.index) + ']');
    }

    return internals.parseObject(keys, val, options);
};


module.exports = function (str, options) {

    if (str === '' ||
        str === null ||
        typeof str === 'undefined') {

        return {};
    }

    options = options || {};
    options.delimiter = typeof options.delimiter === 'string' || Utils.isRegExp(options.delimiter) ? options.delimiter : internals.delimiter;
    options.depth = typeof options.depth === 'number' ? options.depth : internals.depth;
    options.arrayLimit = typeof options.arrayLimit === 'number' ? options.arrayLimit : internals.arrayLimit;
    options.parameterLimit = typeof options.parameterLimit === 'number' ? options.parameterLimit : internals.parameterLimit;

    var tempObj = typeof str === 'string' ? internals.parseValues(str, options) : str;
    var obj = {};

    // Iterate over the keys and setup the new object

    var keys = Object.keys(tempObj);
    for (var i = 0, il = keys.length; i < il; ++i) {
        var key = keys[i];
        var newObj = internals.parseKeys(key, tempObj[key], options);
        obj = Utils.merge(obj, newObj);
    }

    return Utils.compact(obj);
};

},{"./utils":214}],213:[function(require,module,exports){
// Load modules

var Utils = require('./utils');


// Declare internals

var internals = {
    delimiter: '&'
};


internals.stringify = function (obj, prefix) {

    if (Utils.isBuffer(obj)) {
        obj = obj.toString();
    }
    else if (obj instanceof Date) {
        obj = obj.toISOString();
    }
    else if (obj === null) {
        obj = '';
    }

    if (typeof obj === 'string' ||
        typeof obj === 'number' ||
        typeof obj === 'boolean') {

        return [encodeURIComponent(prefix) + '=' + encodeURIComponent(obj)];
    }

    var values = [];

    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            values = values.concat(internals.stringify(obj[key], prefix + '[' + key + ']'));
        }
    }

    return values;
};


module.exports = function (obj, options) {

    options = options || {};
    var delimiter = typeof options.delimiter === 'undefined' ? internals.delimiter : options.delimiter;

    var keys = [];

    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            keys = keys.concat(internals.stringify(obj[key], key));
        }
    }

    return keys.join(delimiter);
};

},{"./utils":214}],214:[function(require,module,exports){
(function (Buffer){
// Load modules


// Declare internals

var internals = {};


exports.arrayToObject = function (source) {

    var obj = {};
    for (var i = 0, il = source.length; i < il; ++i) {
        if (typeof source[i] !== 'undefined') {

            obj[i] = source[i];
        }
    }

    return obj;
};


exports.merge = function (target, source) {

    if (!source) {
        return target;
    }

    if (Array.isArray(source)) {
        for (var i = 0, il = source.length; i < il; ++i) {
            if (typeof source[i] !== 'undefined') {
                if (typeof target[i] === 'object') {
                    target[i] = exports.merge(target[i], source[i]);
                }
                else {
                    target[i] = source[i];
                }
            }
        }

        return target;
    }

    if (Array.isArray(target)) {
        if (typeof source !== 'object') {
            target.push(source);
            return target;
        }
        else {
            target = exports.arrayToObject(target);
        }
    }

    var keys = Object.keys(source);
    for (var k = 0, kl = keys.length; k < kl; ++k) {
        var key = keys[k];
        var value = source[key];

        if (value &&
            typeof value === 'object') {

            if (!target[key]) {
                target[key] = value;
            }
            else {
                target[key] = exports.merge(target[key], value);
            }
        }
        else {
            target[key] = value;
        }
    }

    return target;
};


exports.decode = function (str) {

    try {
        return decodeURIComponent(str.replace(/\+/g, ' '));
    } catch (e) {
        return str;
    }
};


exports.compact = function (obj, refs) {

    if (typeof obj !== 'object' ||
        obj === null) {

        return obj;
    }

    refs = refs || [];
    var lookup = refs.indexOf(obj);
    if (lookup !== -1) {
        return refs[lookup];
    }

    refs.push(obj);

    if (Array.isArray(obj)) {
        var compacted = [];

        for (var i = 0, l = obj.length; i < l; ++i) {
            if (typeof obj[i] !== 'undefined') {
                compacted.push(obj[i]);
            }
        }

        return compacted;
    }

    var keys = Object.keys(obj);
    for (var i = 0, il = keys.length; i < il; ++i) {
        var key = keys[i];
        obj[key] = exports.compact(obj[key], refs);
    }

    return obj;
};


exports.isRegExp = function (obj) {
    return Object.prototype.toString.call(obj) === '[object RegExp]';
};


exports.isBuffer = function (obj) {

    if (typeof Buffer !== 'undefined') {
        return Buffer.isBuffer(obj);
    }
    else {
        return false;
    }
};

}).call(this,require("buffer").Buffer)
},{"buffer":172}],215:[function(require,module,exports){
/** @license MIT License (c) copyright 2010-2014 original author or authors */
/** @author Brian Cavalier */
/** @author John Hann */

(function(define) { 'use strict';
define(function (require) {

	var makePromise = require('./makePromise');
	var Scheduler = require('./Scheduler');
	var async = require('./async');

	return makePromise({
		scheduler: new Scheduler(async)
	});

});
})(typeof define === 'function' && define.amd ? define : function (factory) { module.exports = factory(require); });

},{"./Scheduler":217,"./async":218,"./makePromise":219}],216:[function(require,module,exports){
/** @license MIT License (c) copyright 2010-2014 original author or authors */
/** @author Brian Cavalier */
/** @author John Hann */

(function(define) { 'use strict';
define(function() {
	/**
	 * Circular queue
	 * @param {number} capacityPow2 power of 2 to which this queue's capacity
	 *  will be set initially. eg when capacityPow2 == 3, queue capacity
	 *  will be 8.
	 * @constructor
	 */
	function Queue(capacityPow2) {
		this.head = this.tail = this.length = 0;
		this.buffer = new Array(1 << capacityPow2);
	}

	Queue.prototype.push = function(x) {
		if(this.length === this.buffer.length) {
			this._ensureCapacity(this.length * 2);
		}

		this.buffer[this.tail] = x;
		this.tail = (this.tail + 1) & (this.buffer.length - 1);
		++this.length;
		return this.length;
	};

	Queue.prototype.shift = function() {
		var x = this.buffer[this.head];
		this.buffer[this.head] = void 0;
		this.head = (this.head + 1) & (this.buffer.length - 1);
		--this.length;
		return x;
	};

	Queue.prototype._ensureCapacity = function(capacity) {
		var head = this.head;
		var buffer = this.buffer;
		var newBuffer = new Array(capacity);
		var i = 0;
		var len;

		if(head === 0) {
			len = this.length;
			for(; i<len; ++i) {
				newBuffer[i] = buffer[i];
			}
		} else {
			capacity = buffer.length;
			len = this.tail;
			for(; head<capacity; ++i, ++head) {
				newBuffer[i] = buffer[head];
			}

			for(head=0; head<len; ++i, ++head) {
				newBuffer[i] = buffer[head];
			}
		}

		this.buffer = newBuffer;
		this.head = 0;
		this.tail = this.length;
	};

	return Queue;

});
}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(); }));

},{}],217:[function(require,module,exports){
/** @license MIT License (c) copyright 2010-2014 original author or authors */
/** @author Brian Cavalier */
/** @author John Hann */

(function(define) { 'use strict';
define(function(require) {

	var Queue = require('./Queue');

	// Credit to Twisol (https://github.com/Twisol) for suggesting
	// this type of extensible queue + trampoline approach for next-tick conflation.

	/**
	 * Async task scheduler
	 * @param {function} async function to schedule a single async function
	 * @constructor
	 */
	function Scheduler(async) {
		this._async = async;
		this._queue = new Queue(15);
		this._afterQueue = new Queue(5);
		this._running = false;

		var self = this;
		this.drain = function() {
			self._drain();
		};
	}

	/**
	 * Enqueue a task
	 * @param {{ run:function }} task
	 */
	Scheduler.prototype.enqueue = function(task) {
		this._add(this._queue, task);
	};

	/**
	 * Enqueue a task to run after the main task queue
	 * @param {{ run:function }} task
	 */
	Scheduler.prototype.afterQueue = function(task) {
		this._add(this._afterQueue, task);
	};

	/**
	 * Drain the handler queue entirely, and then the after queue
	 */
	Scheduler.prototype._drain = function() {
		runQueue(this._queue);
		this._running = false;
		runQueue(this._afterQueue);
	};

	/**
	 * Add a task to the q, and schedule drain if not already scheduled
	 * @param {Queue} queue
	 * @param {{run:function}} task
	 * @private
	 */
	Scheduler.prototype._add = function(queue, task) {
		queue.push(task);
		if(!this._running) {
			this._running = true;
			this._async(this.drain);
		}
	};

	/**
	 * Run all the tasks in the q
	 * @param queue
	 */
	function runQueue(queue) {
		while(queue.length > 0) {
			queue.shift().run();
		}
	}

	return Scheduler;

});
}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(require); }));

},{"./Queue":216}],218:[function(require,module,exports){
(function (process){
/** @license MIT License (c) copyright 2010-2014 original author or authors */
/** @author Brian Cavalier */
/** @author John Hann */

(function(define) { 'use strict';
define(function(require) {

	// Sniff "best" async scheduling option
	// Prefer process.nextTick or MutationObserver, then check for
	// vertx and finally fall back to setTimeout

	/*jshint maxcomplexity:6*/
	/*global process,document,setTimeout,MutationObserver,WebKitMutationObserver*/
	var nextTick, MutationObs;

	if (typeof process !== 'undefined' && process !== null &&
		typeof process.nextTick === 'function') {
		nextTick = function(f) {
			process.nextTick(f);
		};

	} else if (MutationObs =
		(typeof MutationObserver === 'function' && MutationObserver) ||
		(typeof WebKitMutationObserver === 'function' && WebKitMutationObserver)) {
		nextTick = (function (document, MutationObserver) {
			var scheduled;
			var el = document.createElement('div');
			var o = new MutationObserver(run);
			o.observe(el, { attributes: true });

			function run() {
				var f = scheduled;
				scheduled = void 0;
				f();
			}

			return function (f) {
				scheduled = f;
				el.setAttribute('class', 'x');
			};
		}(document, MutationObs));

	} else {
		nextTick = (function(cjsRequire) {
			var vertx;
			try {
				// vert.x 1.x || 2.x
				vertx = cjsRequire('vertx');
			} catch (ignore) {}

			if (vertx) {
				if (typeof vertx.runOnLoop === 'function') {
					return vertx.runOnLoop;
				}
				if (typeof vertx.runOnContext === 'function') {
					return vertx.runOnContext;
				}
			}

			// capture setTimeout to avoid being caught by fake timers
			// used in time based tests
			var capturedSetTimeout = setTimeout;
			return function (t) {
				capturedSetTimeout(t, 0);
			};
		}(require));
	}

	return nextTick;
});
}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(require); }));

}).call(this,require("ngpmcQ"))
},{"ngpmcQ":176}],219:[function(require,module,exports){
/** @license MIT License (c) copyright 2010-2014 original author or authors */
/** @author Brian Cavalier */
/** @author John Hann */

(function(define) { 'use strict';
define(function() {

	return function makePromise(environment) {

		var tasks = environment.scheduler;

		var objectCreate = Object.create ||
			function(proto) {
				function Child() {}
				Child.prototype = proto;
				return new Child();
			};

		/**
		 * Create a promise whose fate is determined by resolver
		 * @constructor
		 * @returns {Promise} promise
		 * @name Promise
		 */
		function Promise(resolver, handler) {
			this._handler = resolver === Handler ? handler : init(resolver);
		}

		/**
		 * Run the supplied resolver
		 * @param resolver
		 * @returns {Pending}
		 */
		function init(resolver) {
			var handler = new Pending();

			try {
				resolver(promiseResolve, promiseReject, promiseNotify);
			} catch (e) {
				promiseReject(e);
			}

			return handler;

			/**
			 * Transition from pre-resolution state to post-resolution state, notifying
			 * all listeners of the ultimate fulfillment or rejection
			 * @param {*} x resolution value
			 */
			function promiseResolve (x) {
				handler.resolve(x);
			}
			/**
			 * Reject this promise with reason, which will be used verbatim
			 * @param {Error|*} reason rejection reason, strongly suggested
			 *   to be an Error type
			 */
			function promiseReject (reason) {
				handler.reject(reason);
			}

			/**
			 * Issue a progress event, notifying all progress listeners
			 * @param {*} x progress event payload to pass to all listeners
			 */
			function promiseNotify (x) {
				handler.notify(x);
			}
		}

		// Creation

		Promise.resolve = resolve;
		Promise.reject = reject;
		Promise.never = never;

		Promise._defer = defer;
		Promise._handler = getHandler;

		/**
		 * Returns a trusted promise. If x is already a trusted promise, it is
		 * returned, otherwise returns a new trusted Promise which follows x.
		 * @param  {*} x
		 * @return {Promise} promise
		 */
		function resolve(x) {
			return isPromise(x) ? x
				: new Promise(Handler, new Async(getHandler(x)));
		}

		/**
		 * Return a reject promise with x as its reason (x is used verbatim)
		 * @param {*} x
		 * @returns {Promise} rejected promise
		 */
		function reject(x) {
			return new Promise(Handler, new Async(new Rejected(x)));
		}

		/**
		 * Return a promise that remains pending forever
		 * @returns {Promise} forever-pending promise.
		 */
		function never() {
			return foreverPendingPromise; // Should be frozen
		}

		/**
		 * Creates an internal {promise, resolver} pair
		 * @private
		 * @returns {Promise}
		 */
		function defer() {
			return new Promise(Handler, new Pending());
		}

		// Transformation and flow control

		/**
		 * Transform this promise's fulfillment value, returning a new Promise
		 * for the transformed result.  If the promise cannot be fulfilled, onRejected
		 * is called with the reason.  onProgress *may* be called with updates toward
		 * this promise's fulfillment.
		 * @param {function=} onFulfilled fulfillment handler
		 * @param {function=} onRejected rejection handler
		 * @deprecated @param {function=} onProgress progress handler
		 * @return {Promise} new promise
		 */
		Promise.prototype.then = function(onFulfilled, onRejected) {
			var parent = this._handler;
			var state = parent.join().state();

			if ((typeof onFulfilled !== 'function' && state > 0) ||
				(typeof onRejected !== 'function' && state < 0)) {
				// Short circuit: value will not change, simply share handler
				return new this.constructor(Handler, parent);
			}

			var p = this._beget();
			var child = p._handler;

			parent.chain(child, parent.receiver, onFulfilled, onRejected,
					arguments.length > 2 ? arguments[2] : void 0);

			return p;
		};

		/**
		 * If this promise cannot be fulfilled due to an error, call onRejected to
		 * handle the error. Shortcut for .then(undefined, onRejected)
		 * @param {function?} onRejected
		 * @return {Promise}
		 */
		Promise.prototype['catch'] = function(onRejected) {
			return this.then(void 0, onRejected);
		};

		/**
		 * Creates a new, pending promise of the same type as this promise
		 * @private
		 * @returns {Promise}
		 */
		Promise.prototype._beget = function() {
			var parent = this._handler;
			var child = new Pending(parent.receiver, parent.join().context);
			return new this.constructor(Handler, child);
		};

		// Array combinators

		Promise.all = all;
		Promise.race = race;

		/**
		 * Return a promise that will fulfill when all promises in the
		 * input array have fulfilled, or will reject when one of the
		 * promises rejects.
		 * @param {array} promises array of promises
		 * @returns {Promise} promise for array of fulfillment values
		 */
		function all(promises) {
			/*jshint maxcomplexity:8*/
			var resolver = new Pending();
			var pending = promises.length >>> 0;
			var results = new Array(pending);

			var i, h, x, s;
			for (i = 0; i < promises.length; ++i) {
				x = promises[i];

				if (x === void 0 && !(i in promises)) {
					--pending;
					continue;
				}

				if (maybeThenable(x)) {
					h = getHandlerMaybeThenable(x);

					s = h.state();
					if (s === 0) {
						h.fold(settleAt, i, results, resolver);
					} else if (s > 0) {
						results[i] = h.value;
						--pending;
					} else {
						unreportRemaining(promises, i+1, h);
						resolver.become(h);
						break;
					}

				} else {
					results[i] = x;
					--pending;
				}
			}

			if(pending === 0) {
				resolver.become(new Fulfilled(results));
			}

			return new Promise(Handler, resolver);

			function settleAt(i, x, resolver) {
				/*jshint validthis:true*/
				this[i] = x;
				if(--pending === 0) {
					resolver.become(new Fulfilled(this));
				}
			}
		}

		function unreportRemaining(promises, start, rejectedHandler) {
			var i, h, x;
			for(i=start; i<promises.length; ++i) {
				x = promises[i];
				if(maybeThenable(x)) {
					h = getHandlerMaybeThenable(x);

					if(h !== rejectedHandler) {
						h.visit(h, void 0, h._unreport);
					}
				}
			}
		}

		/**
		 * Fulfill-reject competitive race. Return a promise that will settle
		 * to the same state as the earliest input promise to settle.
		 *
		 * WARNING: The ES6 Promise spec requires that race()ing an empty array
		 * must return a promise that is pending forever.  This implementation
		 * returns a singleton forever-pending promise, the same singleton that is
		 * returned by Promise.never(), thus can be checked with ===
		 *
		 * @param {array} promises array of promises to race
		 * @returns {Promise} if input is non-empty, a promise that will settle
		 * to the same outcome as the earliest input promise to settle. if empty
		 * is empty, returns a promise that will never settle.
		 */
		function race(promises) {
			// Sigh, race([]) is untestable unless we return *something*
			// that is recognizable without calling .then() on it.
			if(Object(promises) === promises && promises.length === 0) {
				return never();
			}

			var h = new Pending();
			var i, x;
			for(i=0; i<promises.length; ++i) {
				x = promises[i];
				if (x !== void 0 && i in promises) {
					getHandler(x).visit(h, h.resolve, h.reject);
				}
			}
			return new Promise(Handler, h);
		}

		// Promise internals
		// Below this, everything is @private

		/**
		 * Get an appropriate handler for x, without checking for cycles
		 * @param {*} x
		 * @returns {object} handler
		 */
		function getHandler(x) {
			if(isPromise(x)) {
				return x._handler.join();
			}
			return maybeThenable(x) ? getHandlerUntrusted(x) : new Fulfilled(x);
		}

		/**
		 * Get a handler for thenable x.
		 * NOTE: You must only call this if maybeThenable(x) == true
		 * @param {object|function|Promise} x
		 * @returns {object} handler
		 */
		function getHandlerMaybeThenable(x) {
			return isPromise(x) ? x._handler.join() : getHandlerUntrusted(x);
		}

		/**
		 * Get a handler for potentially untrusted thenable x
		 * @param {*} x
		 * @returns {object} handler
		 */
		function getHandlerUntrusted(x) {
			try {
				var untrustedThen = x.then;
				return typeof untrustedThen === 'function'
					? new Thenable(untrustedThen, x)
					: new Fulfilled(x);
			} catch(e) {
				return new Rejected(e);
			}
		}

		/**
		 * Handler for a promise that is pending forever
		 * @constructor
		 */
		function Handler() {}

		Handler.prototype.when
			= Handler.prototype.become
			= Handler.prototype.notify
			= Handler.prototype.fail
			= Handler.prototype._unreport
			= Handler.prototype._report
			= noop;

		Handler.prototype._state = 0;

		Handler.prototype.state = function() {
			return this._state;
		};

		/**
		 * Recursively collapse handler chain to find the handler
		 * nearest to the fully resolved value.
		 * @returns {object} handler nearest the fully resolved value
		 */
		Handler.prototype.join = function() {
			var h = this;
			while(h.handler !== void 0) {
				h = h.handler;
			}
			return h;
		};

		Handler.prototype.chain = function(to, receiver, fulfilled, rejected, progress) {
			this.when({
				resolver: to,
				receiver: receiver,
				fulfilled: fulfilled,
				rejected: rejected,
				progress: progress
			});
		};

		Handler.prototype.visit = function(receiver, fulfilled, rejected, progress) {
			this.chain(failIfRejected, receiver, fulfilled, rejected, progress);
		};

		Handler.prototype.fold = function(f, z, c, to) {
			this.visit(to, function(x) {
				f.call(c, z, x, this);
			}, to.reject, to.notify);
		};

		/**
		 * Handler that invokes fail() on any handler it becomes
		 * @constructor
		 */
		function FailIfRejected() {}

		inherit(Handler, FailIfRejected);

		FailIfRejected.prototype.become = function(h) {
			h.fail();
		};

		var failIfRejected = new FailIfRejected();

		/**
		 * Handler that manages a queue of consumers waiting on a pending promise
		 * @constructor
		 */
		function Pending(receiver, inheritedContext) {
			Promise.createContext(this, inheritedContext);

			this.consumers = void 0;
			this.receiver = receiver;
			this.handler = void 0;
			this.resolved = false;
		}

		inherit(Handler, Pending);

		Pending.prototype._state = 0;

		Pending.prototype.resolve = function(x) {
			this.become(getHandler(x));
		};

		Pending.prototype.reject = function(x) {
			if(this.resolved) {
				return;
			}

			this.become(new Rejected(x));
		};

		Pending.prototype.join = function() {
			if (!this.resolved) {
				return this;
			}

			var h = this;

			while (h.handler !== void 0) {
				h = h.handler;
				if (h === this) {
					return this.handler = cycle();
				}
			}

			return h;
		};

		Pending.prototype.run = function() {
			var q = this.consumers;
			var handler = this.join();
			this.consumers = void 0;

			for (var i = 0; i < q.length; ++i) {
				handler.when(q[i]);
			}
		};

		Pending.prototype.become = function(handler) {
			if(this.resolved) {
				return;
			}

			this.resolved = true;
			this.handler = handler;
			if(this.consumers !== void 0) {
				tasks.enqueue(this);
			}

			if(this.context !== void 0) {
				handler._report(this.context);
			}
		};

		Pending.prototype.when = function(continuation) {
			if(this.resolved) {
				tasks.enqueue(new ContinuationTask(continuation, this.handler));
			} else {
				if(this.consumers === void 0) {
					this.consumers = [continuation];
				} else {
					this.consumers.push(continuation);
				}
			}
		};

		Pending.prototype.notify = function(x) {
			if(!this.resolved) {
				tasks.enqueue(new ProgressTask(x, this));
			}
		};

		Pending.prototype.fail = function(context) {
			var c = typeof context === 'undefined' ? this.context : context;
			this.resolved && this.handler.join().fail(c);
		};

		Pending.prototype._report = function(context) {
			this.resolved && this.handler.join()._report(context);
		};

		Pending.prototype._unreport = function() {
			this.resolved && this.handler.join()._unreport();
		};

		/**
		 * Wrap another handler and force it into a future stack
		 * @param {object} handler
		 * @constructor
		 */
		function Async(handler) {
			this.handler = handler;
		}

		inherit(Handler, Async);

		Async.prototype.when = function(continuation) {
			tasks.enqueue(new ContinuationTask(continuation, this));
		};

		Async.prototype._report = function(context) {
			this.join()._report(context);
		};

		Async.prototype._unreport = function() {
			this.join()._unreport();
		};

		/**
		 * Handler that wraps an untrusted thenable and assimilates it in a future stack
		 * @param {function} then
		 * @param {{then: function}} thenable
		 * @constructor
		 */
		function Thenable(then, thenable) {
			Pending.call(this);
			tasks.enqueue(new AssimilateTask(then, thenable, this));
		}

		inherit(Pending, Thenable);

		/**
		 * Handler for a fulfilled promise
		 * @param {*} x fulfillment value
		 * @constructor
		 */
		function Fulfilled(x) {
			Promise.createContext(this);
			this.value = x;
		}

		inherit(Handler, Fulfilled);

		Fulfilled.prototype._state = 1;

		Fulfilled.prototype.fold = function(f, z, c, to) {
			runContinuation3(f, z, this, c, to);
		};

		Fulfilled.prototype.when = function(cont) {
			runContinuation1(cont.fulfilled, this, cont.receiver, cont.resolver);
		};

		var errorId = 0;

		/**
		 * Handler for a rejected promise
		 * @param {*} x rejection reason
		 * @constructor
		 */
		function Rejected(x) {
			Promise.createContext(this);

			this.id = ++errorId;
			this.value = x;
			this.handled = false;
			this.reported = false;

			this._report();
		}

		inherit(Handler, Rejected);

		Rejected.prototype._state = -1;

		Rejected.prototype.fold = function(f, z, c, to) {
			to.become(this);
		};

		Rejected.prototype.when = function(cont) {
			if(typeof cont.rejected === 'function') {
				this._unreport();
			}
			runContinuation1(cont.rejected, this, cont.receiver, cont.resolver);
		};

		Rejected.prototype._report = function(context) {
			tasks.afterQueue(new ReportTask(this, context));
		};

		Rejected.prototype._unreport = function() {
			this.handled = true;
			tasks.afterQueue(new UnreportTask(this));
		};

		Rejected.prototype.fail = function(context) {
			Promise.onFatalRejection(this, context === void 0 ? this.context : context);
		};

		function ReportTask(rejection, context) {
			this.rejection = rejection;
			this.context = context;
		}

		ReportTask.prototype.run = function() {
			if(!this.rejection.handled) {
				this.rejection.reported = true;
				Promise.onPotentiallyUnhandledRejection(this.rejection, this.context);
			}
		};

		function UnreportTask(rejection) {
			this.rejection = rejection;
		}

		UnreportTask.prototype.run = function() {
			if(this.rejection.reported) {
				Promise.onPotentiallyUnhandledRejectionHandled(this.rejection);
			}
		};

		// Unhandled rejection hooks
		// By default, everything is a noop

		// TODO: Better names: "annotate"?
		Promise.createContext
			= Promise.enterContext
			= Promise.exitContext
			= Promise.onPotentiallyUnhandledRejection
			= Promise.onPotentiallyUnhandledRejectionHandled
			= Promise.onFatalRejection
			= noop;

		// Errors and singletons

		var foreverPendingHandler = new Handler();
		var foreverPendingPromise = new Promise(Handler, foreverPendingHandler);

		function cycle() {
			return new Rejected(new TypeError('Promise cycle'));
		}

		// Task runners

		/**
		 * Run a single consumer
		 * @constructor
		 */
		function ContinuationTask(continuation, handler) {
			this.continuation = continuation;
			this.handler = handler;
		}

		ContinuationTask.prototype.run = function() {
			this.handler.join().when(this.continuation);
		};

		/**
		 * Run a queue of progress handlers
		 * @constructor
		 */
		function ProgressTask(value, handler) {
			this.handler = handler;
			this.value = value;
		}

		ProgressTask.prototype.run = function() {
			var q = this.handler.consumers;
			if(q === void 0) {
				return;
			}

			for (var c, i = 0; i < q.length; ++i) {
				c = q[i];
				runNotify(c.progress, this.value, this.handler, c.receiver, c.resolver);
			}
		};

		/**
		 * Assimilate a thenable, sending it's value to resolver
		 * @param {function} then
		 * @param {object|function} thenable
		 * @param {object} resolver
		 * @constructor
		 */
		function AssimilateTask(then, thenable, resolver) {
			this._then = then;
			this.thenable = thenable;
			this.resolver = resolver;
		}

		AssimilateTask.prototype.run = function() {
			var h = this.resolver;
			tryAssimilate(this._then, this.thenable, _resolve, _reject, _notify);

			function _resolve(x) { h.resolve(x); }
			function _reject(x)  { h.reject(x); }
			function _notify(x)  { h.notify(x); }
		};

		function tryAssimilate(then, thenable, resolve, reject, notify) {
			try {
				then.call(thenable, resolve, reject, notify);
			} catch (e) {
				reject(e);
			}
		}

		// Other helpers

		/**
		 * @param {*} x
		 * @returns {boolean} true iff x is a trusted Promise
		 */
		function isPromise(x) {
			return x instanceof Promise;
		}

		/**
		 * Test just enough to rule out primitives, in order to take faster
		 * paths in some code
		 * @param {*} x
		 * @returns {boolean} false iff x is guaranteed *not* to be a thenable
		 */
		function maybeThenable(x) {
			return (typeof x === 'object' || typeof x === 'function') && x !== null;
		}

		function runContinuation1(f, h, receiver, next) {
			if(typeof f !== 'function') {
				return next.become(h);
			}

			Promise.enterContext(h);
			tryCatchReject(f, h.value, receiver, next);
			Promise.exitContext();
		}

		function runContinuation3(f, x, h, receiver, next) {
			if(typeof f !== 'function') {
				return next.become(h);
			}

			Promise.enterContext(h);
			tryCatchReject3(f, x, h.value, receiver, next);
			Promise.exitContext();
		}

		function runNotify(f, x, h, receiver, next) {
			if(typeof f !== 'function') {
				return next.notify(x);
			}

			Promise.enterContext(h);
			tryCatchReturn(f, x, receiver, next);
			Promise.exitContext();
		}

		/**
		 * Return f.call(thisArg, x), or if it throws return a rejected promise for
		 * the thrown exception
		 */
		function tryCatchReject(f, x, thisArg, next) {
			try {
				next.become(getHandler(f.call(thisArg, x)));
			} catch(e) {
				next.become(new Rejected(e));
			}
		}

		/**
		 * Same as above, but includes the extra argument parameter.
		 */
		function tryCatchReject3(f, x, y, thisArg, next) {
			try {
				f.call(thisArg, x, y, next);
			} catch(e) {
				next.become(new Rejected(e));
			}
		}

		/**
		 * Return f.call(thisArg, x), or if it throws, *return* the exception
		 */
		function tryCatchReturn(f, x, thisArg, next) {
			try {
				next.notify(f.call(thisArg, x));
			} catch(e) {
				next.notify(e);
			}
		}

		function inherit(Parent, Child) {
			Child.prototype = objectCreate(Parent.prototype);
			Child.prototype.constructor = Child;
		}

		function noop() {}

		return Promise;
	};
});
}(typeof define === 'function' && define.amd ? define : function(factory) { module.exports = factory(); }));

},{}],220:[function(require,module,exports){
module.exports=require(1)
},{"./focusNode":331}],221:[function(require,module,exports){
module.exports=require(2)
},{"./EventConstants":234,"./EventPropagators":239,"./ExecutionEnvironment":240,"./SyntheticInputEvent":308,"./keyOf":353}],222:[function(require,module,exports){
module.exports=require(3)
},{}],223:[function(require,module,exports){
module.exports=require(4)
},{"./CSSProperty":222,"./ExecutionEnvironment":240,"./camelizeStyleName":319,"./dangerousStyleValue":325,"./hyphenateStyleName":344,"./memoizeStringOnly":355,"./warning":365,"ngpmcQ":176}],224:[function(require,module,exports){
module.exports=require(5)
},{"./Object.assign":245,"./PooledClass":246,"./invariant":346,"ngpmcQ":176}],225:[function(require,module,exports){
module.exports=require(6)
},{"./EventConstants":234,"./EventPluginHub":236,"./EventPropagators":239,"./ExecutionEnvironment":240,"./ReactUpdates":298,"./SyntheticEvent":306,"./isEventSupported":347,"./isTextInputElement":349,"./keyOf":353}],226:[function(require,module,exports){
module.exports=require(7)
},{}],227:[function(require,module,exports){
module.exports=require(8)
},{"./EventConstants":234,"./EventPropagators":239,"./ExecutionEnvironment":240,"./ReactInputSelection":278,"./SyntheticCompositionEvent":304,"./getTextContentAccessor":341,"./keyOf":353}],228:[function(require,module,exports){
module.exports=require(9)
},{"./Danger":231,"./ReactMultiChildUpdateTypes":284,"./getTextContentAccessor":341,"./invariant":346,"ngpmcQ":176}],229:[function(require,module,exports){
module.exports=require(10)
},{"./invariant":346,"ngpmcQ":176}],230:[function(require,module,exports){
module.exports=require(11)
},{"./DOMProperty":229,"./escapeTextForBrowser":329,"./memoizeStringOnly":355,"./warning":365,"ngpmcQ":176}],231:[function(require,module,exports){
module.exports=require(12)
},{"./ExecutionEnvironment":240,"./createNodesFromMarkup":323,"./emptyFunction":327,"./getMarkupWrap":338,"./invariant":346,"ngpmcQ":176}],232:[function(require,module,exports){
module.exports=require(13)
},{"./keyOf":353}],233:[function(require,module,exports){
module.exports=require(14)
},{"./EventConstants":234,"./EventPropagators":239,"./ReactMount":282,"./SyntheticMouseEvent":310,"./keyOf":353}],234:[function(require,module,exports){
module.exports=require(15)
},{"./keyMirror":352}],235:[function(require,module,exports){
module.exports=require(16)
},{"./emptyFunction":327,"ngpmcQ":176}],236:[function(require,module,exports){
module.exports=require(17)
},{"./EventPluginRegistry":237,"./EventPluginUtils":238,"./accumulateInto":316,"./forEachAccumulated":332,"./invariant":346,"ngpmcQ":176}],237:[function(require,module,exports){
module.exports=require(18)
},{"./invariant":346,"ngpmcQ":176}],238:[function(require,module,exports){
module.exports=require(19)
},{"./EventConstants":234,"./invariant":346,"ngpmcQ":176}],239:[function(require,module,exports){
module.exports=require(20)
},{"./EventConstants":234,"./EventPluginHub":236,"./accumulateInto":316,"./forEachAccumulated":332,"ngpmcQ":176}],240:[function(require,module,exports){
module.exports=require(21)
},{}],241:[function(require,module,exports){
module.exports=require(22)
},{"./DOMProperty":229,"./ExecutionEnvironment":240}],242:[function(require,module,exports){
module.exports=require(23)
},{"./ReactPropTypes":291,"./invariant":346,"ngpmcQ":176}],243:[function(require,module,exports){
module.exports=require(24)
},{"./ReactBrowserEventEmitter":249,"./accumulateInto":316,"./forEachAccumulated":332,"./invariant":346,"ngpmcQ":176}],244:[function(require,module,exports){
module.exports=require(25)
},{"./EventConstants":234,"./emptyFunction":327}],245:[function(require,module,exports){
module.exports=require(26)
},{}],246:[function(require,module,exports){
module.exports=require(27)
},{"./invariant":346,"ngpmcQ":176}],247:[function(require,module,exports){
module.exports=require(28)
},{"./DOMPropertyOperations":230,"./EventPluginUtils":238,"./ExecutionEnvironment":240,"./Object.assign":245,"./ReactChildren":250,"./ReactComponent":251,"./ReactCompositeComponent":253,"./ReactContext":254,"./ReactCurrentOwner":255,"./ReactDOM":256,"./ReactDOMComponent":258,"./ReactDefaultInjection":268,"./ReactElement":271,"./ReactElementValidator":272,"./ReactInstanceHandles":279,"./ReactLegacyElement":280,"./ReactMount":282,"./ReactMultiChild":283,"./ReactPerf":287,"./ReactPropTypes":291,"./ReactServerRendering":295,"./ReactTextComponent":297,"./deprecated":326,"./onlyChild":357,"ngpmcQ":176}],248:[function(require,module,exports){
module.exports=require(29)
},{"./ReactEmptyComponent":273,"./ReactMount":282,"./invariant":346,"ngpmcQ":176}],249:[function(require,module,exports){
module.exports=require(30)
},{"./EventConstants":234,"./EventPluginHub":236,"./EventPluginRegistry":237,"./Object.assign":245,"./ReactEventEmitterMixin":275,"./ViewportMetrics":315,"./isEventSupported":347}],250:[function(require,module,exports){
module.exports=require(31)
},{"./PooledClass":246,"./traverseAllChildren":364,"./warning":365,"ngpmcQ":176}],251:[function(require,module,exports){
module.exports=require(32)
},{"./Object.assign":245,"./ReactElement":271,"./ReactOwner":286,"./ReactUpdates":298,"./invariant":346,"./keyMirror":352,"ngpmcQ":176}],252:[function(require,module,exports){
module.exports=require(33)
},{"./ReactDOMIDOperations":260,"./ReactMarkupChecksum":281,"./ReactMount":282,"./ReactPerf":287,"./ReactReconcileTransaction":293,"./getReactRootElementInContainer":340,"./invariant":346,"./setInnerHTML":360,"ngpmcQ":176}],253:[function(require,module,exports){
module.exports=require(34)
},{"./Object.assign":245,"./ReactComponent":251,"./ReactContext":254,"./ReactCurrentOwner":255,"./ReactElement":271,"./ReactElementValidator":272,"./ReactEmptyComponent":273,"./ReactErrorUtils":274,"./ReactLegacyElement":280,"./ReactOwner":286,"./ReactPerf":287,"./ReactPropTransferer":288,"./ReactPropTypeLocationNames":289,"./ReactPropTypeLocations":290,"./ReactUpdates":298,"./instantiateReactComponent":345,"./invariant":346,"./keyMirror":352,"./keyOf":353,"./mapObject":354,"./monitorCodeUse":356,"./shouldUpdateReactComponent":362,"./warning":365,"ngpmcQ":176}],254:[function(require,module,exports){
module.exports=require(35)
},{"./Object.assign":245}],255:[function(require,module,exports){
module.exports=require(36)
},{}],256:[function(require,module,exports){
module.exports=require(37)
},{"./ReactElement":271,"./ReactElementValidator":272,"./ReactLegacyElement":280,"./mapObject":354,"ngpmcQ":176}],257:[function(require,module,exports){
module.exports=require(38)
},{"./AutoFocusMixin":220,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271,"./keyMirror":352}],258:[function(require,module,exports){
module.exports=require(39)
},{"./CSSPropertyOperations":223,"./DOMProperty":229,"./DOMPropertyOperations":230,"./Object.assign":245,"./ReactBrowserComponentMixin":248,"./ReactBrowserEventEmitter":249,"./ReactComponent":251,"./ReactMount":282,"./ReactMultiChild":283,"./ReactPerf":287,"./escapeTextForBrowser":329,"./invariant":346,"./isEventSupported":347,"./keyOf":353,"./monitorCodeUse":356,"ngpmcQ":176}],259:[function(require,module,exports){
module.exports=require(40)
},{"./EventConstants":234,"./LocalEventTrapMixin":243,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271}],260:[function(require,module,exports){
module.exports=require(41)
},{"./CSSPropertyOperations":223,"./DOMChildrenOperations":228,"./DOMPropertyOperations":230,"./ReactMount":282,"./ReactPerf":287,"./invariant":346,"./setInnerHTML":360,"ngpmcQ":176}],261:[function(require,module,exports){
module.exports=require(42)
},{"./EventConstants":234,"./LocalEventTrapMixin":243,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271}],262:[function(require,module,exports){
module.exports=require(43)
},{"./AutoFocusMixin":220,"./DOMPropertyOperations":230,"./LinkedValueUtils":242,"./Object.assign":245,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271,"./ReactMount":282,"./ReactUpdates":298,"./invariant":346,"ngpmcQ":176}],263:[function(require,module,exports){
module.exports=require(44)
},{"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271,"./warning":365,"ngpmcQ":176}],264:[function(require,module,exports){
module.exports=require(45)
},{"./AutoFocusMixin":220,"./LinkedValueUtils":242,"./Object.assign":245,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271,"./ReactUpdates":298}],265:[function(require,module,exports){
module.exports=require(46)
},{"./ExecutionEnvironment":240,"./getNodeForCharacterOffset":339,"./getTextContentAccessor":341}],266:[function(require,module,exports){
module.exports=require(47)
},{"./AutoFocusMixin":220,"./DOMPropertyOperations":230,"./LinkedValueUtils":242,"./Object.assign":245,"./ReactBrowserComponentMixin":248,"./ReactCompositeComponent":253,"./ReactDOM":256,"./ReactElement":271,"./ReactUpdates":298,"./invariant":346,"./warning":365,"ngpmcQ":176}],267:[function(require,module,exports){
module.exports=require(48)
},{"./Object.assign":245,"./ReactUpdates":298,"./Transaction":314,"./emptyFunction":327}],268:[function(require,module,exports){
module.exports=require(49)
},{"./BeforeInputEventPlugin":221,"./ChangeEventPlugin":225,"./ClientReactRootIndex":226,"./CompositionEventPlugin":227,"./DefaultEventPluginOrder":232,"./EnterLeaveEventPlugin":233,"./ExecutionEnvironment":240,"./HTMLDOMPropertyConfig":241,"./MobileSafariClickEventPlugin":244,"./ReactBrowserComponentMixin":248,"./ReactComponentBrowserEnvironment":252,"./ReactDOMButton":257,"./ReactDOMComponent":258,"./ReactDOMForm":259,"./ReactDOMImg":261,"./ReactDOMInput":262,"./ReactDOMOption":263,"./ReactDOMSelect":264,"./ReactDOMTextarea":266,"./ReactDefaultBatchingStrategy":267,"./ReactDefaultPerf":269,"./ReactEventListener":276,"./ReactInjection":277,"./ReactInstanceHandles":279,"./ReactMount":282,"./SVGDOMPropertyConfig":299,"./SelectEventPlugin":300,"./ServerReactRootIndex":301,"./SimpleEventPlugin":302,"./createFullPageComponent":322,"ngpmcQ":176}],269:[function(require,module,exports){
module.exports=require(50)
},{"./DOMProperty":229,"./ReactDefaultPerfAnalysis":270,"./ReactMount":282,"./ReactPerf":287,"./performanceNow":359}],270:[function(require,module,exports){
module.exports=require(51)
},{"./Object.assign":245}],271:[function(require,module,exports){
module.exports=require(52)
},{"./ReactContext":254,"./ReactCurrentOwner":255,"./warning":365,"ngpmcQ":176}],272:[function(require,module,exports){
module.exports=require(53)
},{"./ReactCurrentOwner":255,"./ReactElement":271,"./ReactPropTypeLocations":290,"./monitorCodeUse":356,"./warning":365,"ngpmcQ":176}],273:[function(require,module,exports){
module.exports=require(54)
},{"./ReactElement":271,"./invariant":346,"ngpmcQ":176}],274:[function(require,module,exports){
module.exports=require(55)
},{}],275:[function(require,module,exports){
module.exports=require(56)
},{"./EventPluginHub":236}],276:[function(require,module,exports){
module.exports=require(57)
},{"./EventListener":235,"./ExecutionEnvironment":240,"./Object.assign":245,"./PooledClass":246,"./ReactInstanceHandles":279,"./ReactMount":282,"./ReactUpdates":298,"./getEventTarget":337,"./getUnboundedScrollPosition":342}],277:[function(require,module,exports){
module.exports=require(58)
},{"./DOMProperty":229,"./EventPluginHub":236,"./ReactBrowserEventEmitter":249,"./ReactComponent":251,"./ReactCompositeComponent":253,"./ReactEmptyComponent":273,"./ReactNativeComponent":285,"./ReactPerf":287,"./ReactRootIndex":294,"./ReactUpdates":298}],278:[function(require,module,exports){
module.exports=require(59)
},{"./ReactDOMSelection":265,"./containsNode":320,"./focusNode":331,"./getActiveElement":333}],279:[function(require,module,exports){
module.exports=require(60)
},{"./ReactRootIndex":294,"./invariant":346,"ngpmcQ":176}],280:[function(require,module,exports){
module.exports=require(61)
},{"./ReactCurrentOwner":255,"./invariant":346,"./monitorCodeUse":356,"./warning":365,"ngpmcQ":176}],281:[function(require,module,exports){
module.exports=require(62)
},{"./adler32":317}],282:[function(require,module,exports){
module.exports=require(63)
},{"./DOMProperty":229,"./ReactBrowserEventEmitter":249,"./ReactCurrentOwner":255,"./ReactElement":271,"./ReactInstanceHandles":279,"./ReactLegacyElement":280,"./ReactPerf":287,"./containsNode":320,"./deprecated":326,"./getReactRootElementInContainer":340,"./instantiateReactComponent":345,"./invariant":346,"./shouldUpdateReactComponent":362,"./warning":365,"ngpmcQ":176}],283:[function(require,module,exports){
module.exports=require(64)
},{"./ReactComponent":251,"./ReactMultiChildUpdateTypes":284,"./flattenChildren":330,"./instantiateReactComponent":345,"./shouldUpdateReactComponent":362}],284:[function(require,module,exports){
module.exports=require(65)
},{"./keyMirror":352}],285:[function(require,module,exports){
module.exports=require(66)
},{"./Object.assign":245,"./invariant":346,"ngpmcQ":176}],286:[function(require,module,exports){
module.exports=require(67)
},{"./emptyObject":328,"./invariant":346,"ngpmcQ":176}],287:[function(require,module,exports){
module.exports=require(68)
},{"ngpmcQ":176}],288:[function(require,module,exports){
module.exports=require(69)
},{"./Object.assign":245,"./emptyFunction":327,"./invariant":346,"./joinClasses":351,"./warning":365,"ngpmcQ":176}],289:[function(require,module,exports){
module.exports=require(70)
},{"ngpmcQ":176}],290:[function(require,module,exports){
module.exports=require(71)
},{"./keyMirror":352}],291:[function(require,module,exports){
module.exports=require(72)
},{"./ReactElement":271,"./ReactPropTypeLocationNames":289,"./deprecated":326,"./emptyFunction":327}],292:[function(require,module,exports){
module.exports=require(73)
},{"./Object.assign":245,"./PooledClass":246,"./ReactBrowserEventEmitter":249}],293:[function(require,module,exports){
module.exports=require(74)
},{"./CallbackQueue":224,"./Object.assign":245,"./PooledClass":246,"./ReactBrowserEventEmitter":249,"./ReactInputSelection":278,"./ReactPutListenerQueue":292,"./Transaction":314}],294:[function(require,module,exports){
module.exports=require(75)
},{}],295:[function(require,module,exports){
module.exports=require(76)
},{"./ReactElement":271,"./ReactInstanceHandles":279,"./ReactMarkupChecksum":281,"./ReactServerRenderingTransaction":296,"./instantiateReactComponent":345,"./invariant":346,"ngpmcQ":176}],296:[function(require,module,exports){
module.exports=require(77)
},{"./CallbackQueue":224,"./Object.assign":245,"./PooledClass":246,"./ReactPutListenerQueue":292,"./Transaction":314,"./emptyFunction":327}],297:[function(require,module,exports){
module.exports=require(78)
},{"./DOMPropertyOperations":230,"./Object.assign":245,"./ReactComponent":251,"./ReactElement":271,"./escapeTextForBrowser":329}],298:[function(require,module,exports){
module.exports=require(79)
},{"./CallbackQueue":224,"./Object.assign":245,"./PooledClass":246,"./ReactCurrentOwner":255,"./ReactPerf":287,"./Transaction":314,"./invariant":346,"./warning":365,"ngpmcQ":176}],299:[function(require,module,exports){
module.exports=require(80)
},{"./DOMProperty":229}],300:[function(require,module,exports){
module.exports=require(81)
},{"./EventConstants":234,"./EventPropagators":239,"./ReactInputSelection":278,"./SyntheticEvent":306,"./getActiveElement":333,"./isTextInputElement":349,"./keyOf":353,"./shallowEqual":361}],301:[function(require,module,exports){
module.exports=require(82)
},{}],302:[function(require,module,exports){
module.exports=require(83)
},{"./EventConstants":234,"./EventPluginUtils":238,"./EventPropagators":239,"./SyntheticClipboardEvent":303,"./SyntheticDragEvent":305,"./SyntheticEvent":306,"./SyntheticFocusEvent":307,"./SyntheticKeyboardEvent":309,"./SyntheticMouseEvent":310,"./SyntheticTouchEvent":311,"./SyntheticUIEvent":312,"./SyntheticWheelEvent":313,"./getEventCharCode":334,"./invariant":346,"./keyOf":353,"./warning":365,"ngpmcQ":176}],303:[function(require,module,exports){
module.exports=require(84)
},{"./SyntheticEvent":306}],304:[function(require,module,exports){
module.exports=require(85)
},{"./SyntheticEvent":306}],305:[function(require,module,exports){
module.exports=require(86)
},{"./SyntheticMouseEvent":310}],306:[function(require,module,exports){
module.exports=require(87)
},{"./Object.assign":245,"./PooledClass":246,"./emptyFunction":327,"./getEventTarget":337}],307:[function(require,module,exports){
module.exports=require(88)
},{"./SyntheticUIEvent":312}],308:[function(require,module,exports){
module.exports=require(89)
},{"./SyntheticEvent":306}],309:[function(require,module,exports){
module.exports=require(90)
},{"./SyntheticUIEvent":312,"./getEventCharCode":334,"./getEventKey":335,"./getEventModifierState":336}],310:[function(require,module,exports){
module.exports=require(91)
},{"./SyntheticUIEvent":312,"./ViewportMetrics":315,"./getEventModifierState":336}],311:[function(require,module,exports){
module.exports=require(92)
},{"./SyntheticUIEvent":312,"./getEventModifierState":336}],312:[function(require,module,exports){
module.exports=require(93)
},{"./SyntheticEvent":306,"./getEventTarget":337}],313:[function(require,module,exports){
module.exports=require(94)
},{"./SyntheticMouseEvent":310}],314:[function(require,module,exports){
module.exports=require(95)
},{"./invariant":346,"ngpmcQ":176}],315:[function(require,module,exports){
module.exports=require(96)
},{"./getUnboundedScrollPosition":342}],316:[function(require,module,exports){
module.exports=require(97)
},{"./invariant":346,"ngpmcQ":176}],317:[function(require,module,exports){
module.exports=require(98)
},{}],318:[function(require,module,exports){
module.exports=require(99)
},{}],319:[function(require,module,exports){
module.exports=require(100)
},{"./camelize":318}],320:[function(require,module,exports){
module.exports=require(101)
},{"./isTextNode":350}],321:[function(require,module,exports){
module.exports=require(102)
},{"./toArray":363}],322:[function(require,module,exports){
module.exports=require(103)
},{"./ReactCompositeComponent":253,"./ReactElement":271,"./invariant":346,"ngpmcQ":176}],323:[function(require,module,exports){
module.exports=require(104)
},{"./ExecutionEnvironment":240,"./createArrayFrom":321,"./getMarkupWrap":338,"./invariant":346,"ngpmcQ":176}],324:[function(require,module,exports){
/**
 * Copyright 2013-2014, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule cx
 */

/**
 * This function is used to mark string literals representing CSS class names
 * so that they can be transformed statically. This allows for modularization
 * and minification of CSS class names.
 *
 * In static_upstream, this function is actually implemented, but it should
 * eventually be replaced with something more descriptive, and the transform
 * that is used in the main stack should be ported for use elsewhere.
 *
 * @param string|object className to modularize, or an object of key/values.
 *                      In the object case, the values are conditions that
 *                      determine if the className keys should be included.
 * @param [string ...]  Variable list of classNames in the string case.
 * @return string       Renderable space-separated CSS className.
 */
function cx(classNames) {
  if (typeof classNames == 'object') {
    return Object.keys(classNames).filter(function(className) {
      return classNames[className];
    }).join(' ');
  } else {
    return Array.prototype.join.call(arguments, ' ');
  }
}

module.exports = cx;

},{}],325:[function(require,module,exports){
module.exports=require(105)
},{"./CSSProperty":222}],326:[function(require,module,exports){
module.exports=require(106)
},{"./Object.assign":245,"./warning":365,"ngpmcQ":176}],327:[function(require,module,exports){
module.exports=require(107)
},{}],328:[function(require,module,exports){
module.exports=require(108)
},{"ngpmcQ":176}],329:[function(require,module,exports){
module.exports=require(109)
},{}],330:[function(require,module,exports){
module.exports=require(110)
},{"./ReactTextComponent":297,"./traverseAllChildren":364,"./warning":365,"ngpmcQ":176}],331:[function(require,module,exports){
module.exports=require(111)
},{}],332:[function(require,module,exports){
module.exports=require(112)
},{}],333:[function(require,module,exports){
module.exports=require(113)
},{}],334:[function(require,module,exports){
module.exports=require(114)
},{}],335:[function(require,module,exports){
module.exports=require(115)
},{"./getEventCharCode":334}],336:[function(require,module,exports){
module.exports=require(116)
},{}],337:[function(require,module,exports){
module.exports=require(117)
},{}],338:[function(require,module,exports){
module.exports=require(118)
},{"./ExecutionEnvironment":240,"./invariant":346,"ngpmcQ":176}],339:[function(require,module,exports){
module.exports=require(119)
},{}],340:[function(require,module,exports){
module.exports=require(120)
},{}],341:[function(require,module,exports){
module.exports=require(121)
},{"./ExecutionEnvironment":240}],342:[function(require,module,exports){
module.exports=require(122)
},{}],343:[function(require,module,exports){
module.exports=require(123)
},{}],344:[function(require,module,exports){
module.exports=require(124)
},{"./hyphenate":343}],345:[function(require,module,exports){
module.exports=require(125)
},{"./ReactElement":271,"./ReactEmptyComponent":273,"./ReactLegacyElement":280,"./ReactNativeComponent":285,"./warning":365,"ngpmcQ":176}],346:[function(require,module,exports){
module.exports=require(126)
},{"ngpmcQ":176}],347:[function(require,module,exports){
module.exports=require(127)
},{"./ExecutionEnvironment":240}],348:[function(require,module,exports){
module.exports=require(128)
},{}],349:[function(require,module,exports){
module.exports=require(129)
},{}],350:[function(require,module,exports){
module.exports=require(130)
},{"./isNode":348}],351:[function(require,module,exports){
module.exports=require(131)
},{}],352:[function(require,module,exports){
module.exports=require(132)
},{"./invariant":346,"ngpmcQ":176}],353:[function(require,module,exports){
module.exports=require(133)
},{}],354:[function(require,module,exports){
module.exports=require(134)
},{}],355:[function(require,module,exports){
module.exports=require(135)
},{}],356:[function(require,module,exports){
module.exports=require(136)
},{"./invariant":346,"ngpmcQ":176}],357:[function(require,module,exports){
module.exports=require(137)
},{"./ReactElement":271,"./invariant":346,"ngpmcQ":176}],358:[function(require,module,exports){
module.exports=require(138)
},{"./ExecutionEnvironment":240}],359:[function(require,module,exports){
module.exports=require(139)
},{"./performance":358}],360:[function(require,module,exports){
module.exports=require(140)
},{"./ExecutionEnvironment":240}],361:[function(require,module,exports){
module.exports=require(141)
},{}],362:[function(require,module,exports){
module.exports=require(142)
},{}],363:[function(require,module,exports){
module.exports=require(143)
},{"./invariant":346,"ngpmcQ":176}],364:[function(require,module,exports){
module.exports=require(144)
},{"./ReactElement":271,"./ReactInstanceHandles":279,"./invariant":346,"ngpmcQ":176}],365:[function(require,module,exports){
module.exports=require(145)
},{"./emptyFunction":327,"ngpmcQ":176}],366:[function(require,module,exports){
module.exports=require(146)
},{"./lib/React":247}],367:[function(require,module,exports){
var AppDispatcher = require('../dispatcher/AppDispatcher');
var AppConstants = require('../constants/AppConstants');
var GithubUtils = require('../utils/GithubUtils');

var GithubActions = {
  getUserBio: function(username){
    GithubUtils.getBio(username)
      .then(function(response){
        AppDispatcher.handleAction({
            actionType: AppConstants.GITHUB_USER_BIO,
            data: response.data
        });
      });
  },
  getUserRepos: function(username){
    GithubUtils.getRepos(username)
      .then(function(response){
        AppDispatcher.handleAction({
            actionType: AppConstants.GITHUB_USER_REPOS,
            data: response.data
        });
      });
  },
  changeUser: function(username){
    AppDispatcher.handleAction({
        actionType: AppConstants.GITHUB_CHANGE_USER,
        data: username
    });
  }
};

module.exports = GithubActions;
},{"../constants/AppConstants":380,"../dispatcher/AppDispatcher":381,"../utils/GithubUtils":386}],368:[function(require,module,exports){
var AppDispatcher = require('../dispatcher/AppDispatcher');
var AppConstants = require('../constants/AppConstants');
var FirebaseUtils = require('../utils/FirebaseUtils');

var NoteActions = {
  addNote: function(noteObj){
    AppDispatcher.handleAction({
      actionType: AppConstants.ADD_NOTE,
      data: noteObj.note
    });
    FirebaseUtils.addNote(noteObj);
  },
  changeUser: function(username){
    //see http://stackoverflow.com/questions/25630611/should-flux-stores-or-actions-or-both-touch-external-services
    // upvoted answer about why I did below.
    //Basically I update async data in my action creator, get the new
    //data, then update the store so the pattern remians action -> dispatcher -> store
    //also on('value') returns the whole collection just once and then calls the cb every time it changes so dispathcher is only triggered once + whenever it changes
    FirebaseUtils.homeInstance().child(username).on('value', function(snapshot){
      AppDispatcher.handleAction({
        actionType: AppConstants.CHANGE_USER,
        data: {
          user: username,
          notes: FirebaseUtils.toArray(snapshot.val())
        }
      });
    });
  }
};

module.exports = NoteActions;
},{"../constants/AppConstants":380,"../dispatcher/AppDispatcher":381,"../utils/FirebaseUtils":385}],369:[function(require,module,exports){
var React = require('React');
var Home = require('./Home');
var Header = require('./Header');
var Router = require('react-router');
var RouteHandler = Router.RouteHandler;

var App = React.createClass({displayName: "App",
  render: function(){
    return (
      React.createElement("div", {className: "main-container"}, 
        React.createElement(Header, null), 
        React.createElement("div", {className: "container inner-container"}, 
          React.createElement(RouteHandler, null)
        )
      )
    )
  }
});

module.exports = App;
},{"./Header":372,"./Home":373,"React":146,"react-router":186}],370:[function(require,module,exports){
var React = require('React');
var GithubActions = require('../../actions/GithubActions');
var GithubStore = require('../../stores/GithubStore');

var Left = React.createClass({displayName: "Left",
  getInitialState: function(){
    return {
      user: '',
      bio: {}
    }
  },
  componentWillReceiveProps: function(obj){
    GithubActions.changeUser(obj.username);
    GithubActions.getUserBio(obj.username);
  },
  componentDidMount: function(){
    GithubActions.changeUser(this.props.username);
    GithubActions.getUserBio(this.props.username);
    GithubStore.addChangeListener(this._onChange);
  },
  componentWillUnmount: function(){
    GithubStore.removeChangeListener(this._onChange);
  },
  _onChange: function(){
    this.setState({
      user: GithubStore.getUser(),
      bio: GithubStore.getBio()
    });
  },
  render: function(){
    return (
      React.createElement("div", null, 
        React.createElement("h3", null, " User Profile "), 
        React.createElement("ul", {className: "list-group"}, 
          this.state.bio.avatar_url && React.createElement("li", {className: "list-group-item"}, " ", React.createElement("img", {src: this.state.bio.avatar_url, className: "img-rounded img-responsive"}), " "), 
          this.state.bio.name && React.createElement("li", {className: "list-group-item"}, " ", this.state.bio.name, " "), 
          this.state.bio.login && React.createElement("li", {className: "list-group-item"}, " Username: ", this.state.bio.login, " "), 
          this.state.bio.email && React.createElement("li", {className: "list-group-item"}, " Email: ", this.state.bio.email, " "), 
          this.state.bio.location && React.createElement("li", {className: "list-group-item"}, " Location: ", this.state.bio.location, " "), 
          this.state.bio.company && React.createElement("li", {className: "list-group-item"}, " Company: ", this.state.bio.company, " "), 
          this.state.bio.followers && React.createElement("li", {className: "list-group-item"}, " Followers: ", this.state.bio.followers, " "), 
          this.state.bio.following && React.createElement("li", {className: "list-group-item"}, " Following: ", this.state.bio.following, " "), 
          this.state.bio.following && React.createElement("li", {className: "list-group-item"}, " Public Repos: ", this.state.bio.public_repos, " "), 
          this.state.bio.email && React.createElement("li", {className: "list-group-item"}, " Blog: ", this.state.bio.blog, " ")
        )
      )
    )
  }
});

module.exports = Left;
},{"../../actions/GithubActions":367,"../../stores/GithubStore":383,"React":146}],371:[function(require,module,exports){
var React = require('React');
var GithubActions = require('../../actions/GithubActions');
var GithubStore = require('../../stores/GithubStore');

var Middle = React.createClass({displayName: "Middle",
  getInitialState: function(){
    return {
      repos: []
    }
  },
  componentWillReceiveProps: function(obj){
    GithubActions.getUserRepos(obj.username);
  },
  componentDidMount: function(){
    GithubActions.getUserRepos(this.props.username);
    GithubStore.addChangeListener(this._onChange);
  },
  componentWillUnmount: function(){
    GithubStore.removeChangeListener(this._onChange);
  },
  _onChange: function(){
    this.setState({
      repos: GithubStore.getRepos()
    });
  },
  render: function(){
    var repos = this.state.repos.map(function(repo){
      return (
        React.createElement("li", {className: "list-group-item"}, 
          repo.url && React.createElement("p", null, React.createElement("h4", null, React.createElement("a", {href: repo.url}, repo.name))), 
          repo.description && React.createElement("p", null, " ", repo.description, " ")
        )
      )
    });
    return (
      React.createElement("div", null, 
        React.createElement("h3", null, " User Repos "), 
        React.createElement("ul", {className: "list-group"}, 
          repos
        )
      )
    )
  }
});

module.exports = Middle;
},{"../../actions/GithubActions":367,"../../stores/GithubStore":383,"React":146}],372:[function(require,module,exports){
var React = require('React');
var SearchGithub = require('./SearchGithub');

var Header = React.createClass({displayName: "Header",
  render: function(){
    return (
      React.createElement("nav", {className: "navbar navbar-default navbar-fixed-top", role: "navigation"}, 
        React.createElement("div", {className: "container"}, 
          React.createElement("div", {className: "navbar-header"}, 
            React.createElement("a", {className: "navbar-brand", href: "/"}, "React/Flux Github Note Taker")
          ), 
          React.createElement("div", {className: "row cushion"}, 
            React.createElement("div", {className: "col-sm-7 col-sm-offset-2"}, 
                React.createElement(SearchGithub, null)
            )
          )
        )
      )
    )
  }
});

module.exports = Header;




},{"./SearchGithub":378,"React":146}],373:[function(require,module,exports){
var React = require('React');
var GithubActions = require('../actions/GithubActions');
var SearchGithub = require('./SearchGithub');

var Home = React.createClass({displayName: "Home",
  render: function(){
    return (
      React.createElement("div", null, 
        React.createElement("div", {className: "row"}, 
          React.createElement("div", {className: "text-center"}, 
            React.createElement("h1", null, " Enter a Github User ")
          )
        ), 
        React.createElement("div", {className: "col-md-offset-3"}, 
          React.createElement(SearchGithub, null)
        ), 
        React.createElement("div", {className: "col-md-12 text-center"}, 
          React.createElement("h5", null, " *Source Code Can Be Found ", React.createElement("a", {href: "https://github.com/tylermcginnis/react-github-notetaker"}, " Here "), " ")
        )
      )
    )
  }
});

module.exports = Home;
},{"../actions/GithubActions":367,"./SearchGithub":378,"React":146}],374:[function(require,module,exports){
var React = require('React');
var NoteActions = require('../../actions/NoteActions');
var NotesStore = require('../../stores/NotesStore');

var AddNote = React.createClass({displayName: "AddNote",
  getInitialState: function(){
    return {newNote: ''}
  },
  handleChange: function(e){
    this.setState({newNote: e.target.value});
  },
  handleSubmit: function(){
    var user = NotesStore.getState().user;
    NoteActions.addNote({user: user, note: this.state.newNote});
    this.setState({newNote: ''});
  },
  render: function(){
    return (
      React.createElement("div", {className: "input-group cushion"}, 
        React.createElement("input", {type: "text", className: "form-control", placeholder: "Add Note", value: this.state.newNote, onChange: this.handleChange}), 
        React.createElement("span", {className: "input-group-btn"}, 
          React.createElement("button", {className: "btn btn-default", type: "button", onClick: this.handleSubmit}, "Submit")
        )
      )
    )
  }
});

module.exports = AddNote;
},{"../../actions/NoteActions":368,"../../stores/NotesStore":384,"React":146}],375:[function(require,module,exports){
var React = require('React');
var NotesStore = require('../../stores/NotesStore');
var AddNote = require('./AddNote');
var NotesList = require('./NotesList');
var NoteActions = require('../../actions/NoteActions');

var Notes = React.createClass({displayName: "Notes",
  getInitialState: function(){
    return {
      notes: NotesStore.getState().notes
    };
  },
  componentWillReceiveProps: function(obj){
    //invoked whenever the route changes usernames
    NoteActions.changeUser(obj.username);
  },
  componentDidMount: function(){
    NoteActions.changeUser(this.props.username);
    NotesStore.addChangeListener(this._onChange);
  },
  componentWillUnmount: function(){
    NotesStore.removeChangeListener(this._onChange);
  },
  render: function(){
    return (
      React.createElement("div", null, 
        React.createElement("h3", null, " Notes for ", this.props.username, " "), 
        React.createElement(AddNote, {username: this.props.username}), 
        React.createElement(NotesList, {notes: this.state.notes})
      )
    )
  },
  _onChange: function(){
    this.setState({
      notes: NotesStore.getState().notes
    })
  }
});

module.exports = Notes;
},{"../../actions/NoteActions":368,"../../stores/NotesStore":384,"./AddNote":374,"./NotesList":376,"React":146}],376:[function(require,module,exports){
var React = require('React');

var NotesList = React.createClass({displayName: "NotesList",
  render: function(){
    var notes = this.props.notes.map(function(note){
      return React.createElement("li", {className: "list-group-item"}, " ", note, " ")
    });
    return (
      React.createElement("ul", {className: "list-group"}, 
        notes
      )
    )
  }
});

module.exports = NotesList;
},{"React":146}],377:[function(require,module,exports){
var React = require('React');
var Router = require('react-router');
var NotesStore = require('../stores/NotesStore');
var Left = require('../components/Github/Left');
var Middle = require('../components/Github/Middle');
var Notes = require('../components/Notes/Notes');

var Profile = React.createClass({displayName: "Profile",
  mixins: [ Router.State ],
  render: function(){
    var username = this.getParams().username;
    return (
      React.createElement("div", {className: "row"}, 
        React.createElement("div", {className: "col-md-4"}, 
          React.createElement(Left, {username: username})
        ), 
        React.createElement("div", {className: "col-md-4"}, 
          React.createElement(Middle, {username: username})
        ), 
        React.createElement("div", {className: "col-md-4"}, 
          React.createElement(Notes, {username: username})
        )
      )
    )
  }
});

module.exports = Profile;
},{"../components/Github/Left":370,"../components/Github/Middle":371,"../components/Notes/Notes":375,"../stores/NotesStore":384,"React":146,"react-router":186}],378:[function(require,module,exports){
var React = require('React');
var Router = require('react-router');

var SearchGithub = React.createClass({displayName: "SearchGithub",
  mixins: [Router.Navigation],
  getInitialState: function(){
    return {username: ''}
  },
  handleChange: function(e){
    this.setState({username: e.target.value});
  },
  handleSubmit: function(){
    var username = this.state.username;
    this.setState({username: ''});
    this.transitionTo('profile', {username: username});
  },
  render: function(){
    return (
      React.createElement("div", null, 
        React.createElement("div", {className: "col-md-5"}, 
          React.createElement("input", {type: "text", className: "form-control", value: this.state.username, onChange: this.handleChange})
        ), 
        React.createElement("div", {className: "col-md-3"}, 
          React.createElement("button", {className: "btn btn-block btn-primary", onClick: this.handleSubmit}, "Search Github")
        )
      )
    )
  }
});

module.exports = SearchGithub;
},{"React":146,"react-router":186}],379:[function(require,module,exports){
var React = require('React');
var App = require('../components/App');
var Home = require('../components/Home');
var Profile = require('../components/Profile')
var Router = require('react-router');
var DefaultRoute = Router.DefaultRoute;
var Route = Router.Route;

module.exports = (
  React.createElement(Route, {name: "app", path: "/", handler: App}, 
    React.createElement(Route, {name: "profile", path: "profile/:username", handler: Profile}), 
    React.createElement(DefaultRoute, {handler: Home})
  )
);
},{"../components/App":369,"../components/Home":373,"../components/Profile":377,"React":146,"react-router":186}],380:[function(require,module,exports){
var AppConstants = {
  ADD_NOTE: 'ADD_NOTE',
  CHANGE_USER: 'CHANGE_USER',
  GITHUB_USER_BIO: 'GITHUB_USER_BIO',
  GITHUB_USER_REPOS: 'GITHUB_USER_REPOS',
  GITHUB_CHANGE_USER: 'GITHUB_CHANGE_USER',
  FIREBASE_HOST: 'https://github-note-taker.firebaseio.com/notes'
};

module.exports = AppConstants;
},{}],381:[function(require,module,exports){
var Dispatcher = require('flux').Dispatcher;
var AppDispatcher = new Dispatcher();

AppDispatcher.handleAction = function(action){
  this.dispatch({
    source: 'VIEW_ACTION',
    action: action
  });
};

module.exports = AppDispatcher;
},{"flux":169}],382:[function(require,module,exports){
var React = require('react');
var Router = require('react-router');
var routes = require('./config/routes');

Router.run(routes, function (Handler) {
  React.render(React.createElement(Handler, null), document.getElementById('app'));
});
},{"./config/routes":379,"react":366,"react-router":186}],383:[function(require,module,exports){
var AppDispatcher = require('../dispatcher/AppDispatcher');
var AppConstants = require('../constants/AppConstants');
var objectAssign = require('react/lib/Object.assign');
var EventEmitter = require('events').EventEmitter;

var CHANGE_EVENT = 'change';

var _state = {
  user: '',
  bio: undefined,
  repos: undefined,
};

var newUser = function(username){
  _state.user = username;
};

var setBio = function(data){
  _state.bio = data;
};

var setRepos = function(data){
  _state.repos = data;
};

var GithubStore = objectAssign({}, EventEmitter.prototype, {
  emitChange: function(){
    this.emit(CHANGE_EVENT);
  },
  addChangeListener: function(cb){
    this.on(CHANGE_EVENT, cb);
  },
  removeChangeListener: function(cb){
    this.removeListener(CHANGE_EVENT, cb);
  },
  getUser: function(){
    return _state.user;
  },
  getBio: function(){
    return _state.bio;
  },
  getRepos: function(){
    return _state.repos;
  }
});

AppDispatcher.register(function(payload){
  var action = payload.action;
  switch(action.actionType){
    case AppConstants.GITHUB_USER_BIO :
      setBio(action.data);
      GithubStore.emit(CHANGE_EVENT);
      break;
    case AppConstants.GITHUB_USER_REPOS :
      setRepos(action.data);
      GithubStore.emit(CHANGE_EVENT);
      break;
    case AppConstants.GITHUB_CHANGE_USER :
      newUser(action.data);
      GithubStore.emit(CHANGE_EVENT);
      break;
    default:
      return true;
  }
});

module.exports = GithubStore;
},{"../constants/AppConstants":380,"../dispatcher/AppDispatcher":381,"events":175,"react/lib/Object.assign":245}],384:[function(require,module,exports){
var AppDispatcher = require('../dispatcher/AppDispatcher');
var AppConstants = require('../constants/AppConstants');
var objectAssign = require('react/lib/Object.assign');
var EventEmitter = require('events').EventEmitter;
var fbRef = require('../utils/FirebaseUtils.js').homeInstance();

var CHANGE_EVENT = 'change';

var _state = {
  notes: [],
  user: ''
};

var addNote = function(note){
  _state.notes.push(note);
};

var changeUser = function(newUserObj){
  _state = {
    user: newUserObj.user,
    notes: newUserObj.notes
  };
};


//Different stores for Github and Notes?
var NotesStore = objectAssign({}, EventEmitter.prototype, {
  getState: function(){
    return _state;
  },
  emitChange: function(){
    this.emit(CHANGE_EVENT);
  },
  addChangeListener: function(cb){
    this.on(CHANGE_EVENT, cb);
  },
  removeChangeListener: function(cb){
    this.removeListener(CHANGE_EVENT, cb);
  }
});

AppDispatcher.register(function(payload){
  var action = payload.action;
  switch(action.actionType){
    case AppConstants.ADD_NOTE :
      addNote(action.data);
      NotesStore.emit(CHANGE_EVENT);
      break;
    case AppConstants.CHANGE_USER :
      changeUser(action.data);
      NotesStore.emit(CHANGE_EVENT);
      break;
    default:
      return true
  };
  return true;
});

module.exports = NotesStore;
},{"../constants/AppConstants":380,"../dispatcher/AppDispatcher":381,"../utils/FirebaseUtils.js":385,"events":175,"react/lib/Object.assign":245}],385:[function(require,module,exports){
var Firebase = require('firebase');
var AppConstants = require('../constants/AppConstants');

var firebaseUtils = {
  homeInstance: function(){
    return new Firebase(AppConstants.FIREBASE_HOST);
  },
  addNote: function(noteObj){
    this.homeInstance().child(noteObj.user).push(noteObj.note);
  },
  toArray: function(obj){
    var arr = [];
    for(var key in obj){
      arr.push(obj[key]);
    }
    return arr;
  }
};

module.exports = firebaseUtils;
},{"../constants/AppConstants":380,"firebase":168}],386:[function(require,module,exports){
var AppConstants = require('../constants/AppConstants');
var axios = require('axios');

var GithubUtils = {
  getBio: function(username){
    var url = "https://api.github.com/users/" + username;
    return axios.get(url);
  },
  getRepos: function(username){
    var url = "https://api.github.com/users/" + username + "/repos";
    return axios.get(url);
  }
};

module.exports = GithubUtils;
},{"../constants/AppConstants":380,"axios":147}]},{},[382])