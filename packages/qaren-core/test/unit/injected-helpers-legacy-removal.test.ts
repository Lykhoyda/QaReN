import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { HELPERS_VERSION, INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const REMOVED_KEYS = [
  'getNavGraph',
  'navigateTo',
  'getStoreState',
  'getComponentState',
  'dispatchAction',
  'getErrors',
  'clearErrors',
  'getConsole',
  'clearConsole',
  'isReady',
  'getAppInfo',
];

const KEPT_KEYS = [
  '__v',
  'dismissKeyboard',
  'getTree',
  'getNavState',
  'readInputValue',
  'clearInputValue',
  'setInputValue',
  'releaseInputDesignation',
  'interact',
  'resolveLadder',
  '__collectAnchors',
  '__extractFiberFromInstance',
  '__findAllRootFibers',
  '__forEachRootFiber',
  '__hidden',
  '__accessibleName',
  '__match',
  '__hostKind',
  '__role',
  'isTestIdFrontmost',
];

const LEGACY_GLOBALS = [
  '__QAREN_CONSOLE__',
  '__QAREN_ERRORS__',
  '__QAREN_CONSOLE_PATCHED__',
  '__QAREN_ORIG_CONSOLE__',
  '__QAREN_ORIG_ERR_HANDLER__',
  '__QAREN_REJECTION_TRACKED__',
];

// The injection-time installs of HELPERS_VERSION 104, verbatim, behind a v104 helper object.
const V104_INSTALLS = String.raw`
(function() {
  globalThis.__QAREN = { __v: 104, getConsole: function() { return JSON.stringify(consoleBuf); }, getErrors: function() { return JSON.stringify(errors); } };

  if (!globalThis.__QAREN_CONSOLE__) globalThis.__QAREN_CONSOLE__ = [];
  var consoleBuf = globalThis.__QAREN_CONSOLE__;
  var CONSOLE_BUF_MAX = 200;

  if (!globalThis.__QAREN_CONSOLE_PATCHED__) {
    globalThis.__QAREN_CONSOLE_PATCHED__ = true;
    var origConsole = {
      log: console.log, warn: console.warn, error: console.error,
      info: console.info, debug: console.debug
    };
    globalThis.__QAREN_ORIG_CONSOLE__ = origConsole;

    function wrapConsole(level) {
      return function() {
        var text = '';
        for (var i = 0; i < arguments.length; i++) {
          if (i > 0) text += ' ';
          try { text += typeof arguments[i] === 'string' ? arguments[i] : JSON.stringify(arguments[i]); }
          catch(e) { text += String(arguments[i]); }
        }
        if (text.indexOf('__RN_NET__:') === 0) {
          origConsole[level].apply(console, arguments);
          return;
        }
        consoleBuf.push({ level: level, text: text, timestamp: new Date().toISOString() });
        if (consoleBuf.length > CONSOLE_BUF_MAX) consoleBuf.shift();
        origConsole[level].apply(console, arguments);
      };
    }

    console.log = wrapConsole('log');
    console.warn = wrapConsole('warn');
    console.error = wrapConsole('error');
    console.info = wrapConsole('info');
    console.debug = wrapConsole('debug');
  } else {
    consoleBuf = globalThis.__QAREN_CONSOLE__;
  }

  if (!globalThis.__QAREN_ERRORS__) globalThis.__QAREN_ERRORS__ = [];
  var errors = globalThis.__QAREN_ERRORS__;

  try {
    if (globalThis.__QAREN_ORIG_ERR_HANDLER__ === undefined) {
      globalThis.__QAREN_ORIG_ERR_HANDLER__ = ErrorUtils.getGlobalHandler();
    }
    var origHandler = globalThis.__QAREN_ORIG_ERR_HANDLER__;
    ErrorUtils.setGlobalHandler(function(error, isFatal) {
      errors.push({
        message: (error && error.message) || String(error),
        stack: error && error.stack && error.stack.split('\n').slice(0, 8).join('\n'),
        isFatal: isFatal,
        timestamp: new Date().toISOString()
      });
      if (errors.length > 50) errors.shift();
      if (origHandler) origHandler(error, isFatal);
    });
  } catch(e) {}

  if (!globalThis.__QAREN_REJECTION_TRACKED__) try {
    if (globalThis.HermesInternal && globalThis.HermesInternal.enablePromiseRejectionTracker) {
      globalThis.__QAREN_REJECTION_TRACKED__ = true;
      globalThis.HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: function(id, error) {
          errors.push({
            message: (error && error.message) || String(error),
            type: 'unhandled_promise',
            timestamp: new Date().toISOString()
          });
          if (errors.length > 50) errors.shift();
        }
      });
    }
  } catch(e) {}
})();
`;

type Handler = (error: unknown, isFatal?: boolean) => void;
type Tracker = { onUnhandled: (id: number, error: unknown) => void };
type Runtime = Record<string, unknown> & {
  console: Record<string, (...args: unknown[]) => void>;
  __QAREN?: Record<string, unknown>;
};

function createRuntime() {
  const logged: unknown[][] = [];
  const appHandled: unknown[] = [];
  const trackers: Tracker[] = [];
  const appHandler: Handler = (error) => appHandled.push(error);
  let globalHandler: Handler = appHandler;
  const appLog = (...args: unknown[]) => logged.push(args);
  const levels = ['log', 'warn', 'error', 'info', 'debug'];
  const runtime: Runtime = {
    Array,
    Object,
    JSON,
    Map,
    Set,
    WeakSet,
    WeakMap,
    Error,
    Date,
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Promise,
    setTimeout,
    clearTimeout,
    console: Object.fromEntries(levels.map((level) => [level, appLog])),
    ErrorUtils: {
      getGlobalHandler: () => globalHandler,
      setGlobalHandler: (handler: Handler) => {
        globalHandler = handler;
      },
    },
    HermesInternal: { enablePromiseRejectionTracker: (options: Tracker) => trackers.push(options) },
  };
  runtime.globalThis = runtime;
  vm.createContext(runtime);
  return {
    runtime,
    logged,
    appHandled,
    trackers,
    appLog,
    appHandler,
    globalHandler: () => globalHandler,
    run: (source: string) => vm.runInContext(source, runtime),
  };
}

function assertCurrentSurface(runtime: Runtime) {
  const helpers = runtime.__QAREN!;
  assert.equal(helpers.__v, HELPERS_VERSION);
  assert.deepEqual(Object.keys(helpers), KEPT_KEYS);
  for (const key of REMOVED_KEYS) assert.equal(key in helpers, false, key);
}

test('fresh injection installs no console, error or rejection hooks', () => {
  const app = createRuntime();
  const consoleBefore = { ...app.runtime.console };
  app.run(INJECTED_HELPERS);

  assertCurrentSurface(app.runtime);
  assert.deepEqual(app.runtime.console, consoleBefore);
  assert.equal(app.globalHandler(), app.appHandler);
  assert.equal(app.trackers.length, 0);
  for (const name of LEGACY_GLOBALS) assert.equal(name in app.runtime, false, name);
});

test('old-to-new replacement empties the v104 buffers and keeps the wrapper chain', () => {
  const app = createRuntime();
  app.run(V104_INSTALLS);
  const oldConsole = { ...app.runtime.console };
  const oldHandler = app.globalHandler();
  const consoleBuffer = app.runtime.__QAREN_CONSOLE__ as unknown[];
  const errorBuffer = app.runtime.__QAREN_ERRORS__ as unknown[];
  app.runtime.console.log!('before upgrade');
  oldHandler(new Error('before upgrade'));
  assert.equal(app.trackers.length, 1);
  app.trackers[0]!.onUnhandled(1, new Error('rejected before upgrade'));
  assert.equal(consoleBuffer.length, 1);
  assert.equal(errorBuffer.length, 2);

  app.run(INJECTED_HELPERS);

  assertCurrentSurface(app.runtime);
  assert.equal(consoleBuffer.length, 0);
  assert.equal(errorBuffer.length, 0);
  assert.equal('__QAREN_CONSOLE__' in app.runtime, false);
  assert.equal('__QAREN_ERRORS__' in app.runtime, false);
  // A later patch may wrap the old wrappers, so they and their flags stay.
  assert.deepEqual(app.runtime.console, oldConsole);
  assert.equal(app.globalHandler(), oldHandler);
  for (const name of LEGACY_GLOBALS.slice(2)) assert.ok(app.runtime[name], name);
  assert.equal(app.trackers.length, 1);

  const logsBefore = app.logged.length;
  app.runtime.console.warn!('after upgrade');
  const crash = new Error('after upgrade');
  oldHandler(crash, true);
  app.trackers[0]!.onUnhandled(2, new Error('rejected after upgrade'));
  assert.deepEqual(app.logged.slice(logsBefore), [['after upgrade']], 'old wrapper still forwards');
  assert.equal(app.appHandled.at(-1), crash, 'old handler still forwards');
  assert.equal(consoleBuffer.length, 0, 'old console wrapper stops recording');
  assert.equal(errorBuffer.length, 0, 'old error and rejection hooks stop recording');
});

test('re-injecting the current version is a no-op', () => {
  const app = createRuntime();
  app.run(INJECTED_HELPERS);
  const helpers = app.runtime.__QAREN;
  app.run(INJECTED_HELPERS);
  assert.equal(app.runtime.__QAREN, helpers);
});
