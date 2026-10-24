import { PRIVATE_INPUT_LIMITS } from './qa/private-input-limits.js';
import { TYPOGRAPHY_TEXT_LIMITS } from './qa/host-typography.js';
import { INPUT_HOST_TYPES } from './qa/input-host-types.js';

// Bump when the injected surface changes so warm runtimes replace stale helpers.
export const HELPERS_VERSION = 100;

export const INJECTED_HELPERS = `
(function() {
  var __HELPERS_VERSION__ = ${HELPERS_VERSION};
  if (globalThis.__QAREN && globalThis.__QAREN.__v === __HELPERS_VERSION__) return;
  if (globalThis.__QAREN) delete globalThis.__QAREN;

  // Issue #126 — legacy renderer iteration cap. Root-union scans combine this
  // numeric range with the hook's registered IDs so sparse/higher IDs are not
  // missed and partially implemented hook registries retain legacy coverage
  // (GH #597). The early-exit heuristic applies only when no registry is usable.
  var MAX_RENDERER_IDS = 20;
  var MAX_REGISTERED_RENDERER_IDS = 100;
  var EARLY_EXIT_EMPTY_STREAK = 3;

  // GH #525 — bounded no-app-content render evidence for getNavState. Right
  // after a reload the dev shell roots commit long before any app component, so
  // a root set with no app composite in it proves the UI is still mounting. The
  // allowlist plus the scan bound keep the probe fail-closed: a mounted dev app
  // always renders named composites (AppContainer renders LogBox beside them).
  var NAV_SHELL_SCAN_MAX = 200;
  // renderApplication wraps EVERY surface (LogBox's included) in
  // '<debugName>(RootComponent)' > AppContainer, and dev AppContainer renders two
  // composite Views plus these overlays — so the dev shell is not app content. An
  // app root still carries its own '<appName>(RootComponent)' plus app
  // composites, which are not allowlisted. Exact names only: a real app merely
  // NAMED LogBox-something (e.g. 'LogBoxDemo(RootComponent)') is app content.
  var NAV_SHELL_WRAPPERS = [
    'AppContainer',
    'View',
    'DebuggingOverlay',
    'ReactDevToolsOverlay',
    'ReactDevToolsOverlayDeferred',
    'Inspector',
    'InspectorDeferred',
    'TraceUpdateOverlay',
    'LogBox(RootComponent)',
    'LogBoxStateSubscription',
    '_LogBoxStateSubscription',
    'LogBoxNotificationContainer',
    '_LogBoxNotificationContainer',
    'LogBoxInspectorContainer',
    '_LogBoxInspectorContainer'
  ];

  // Synchronous scan result; finished stays false after the GH #789 empty-streak exit.
  var lastRootScan = { rendererErrors: 0, erroredRendererIds: [], extraRootsError: false, visited: {}, finished: false, errors: [] };

  function scanError(rendererId, phase, e, bounds) {
    var message;
    if (bounds && bounds.private) message = 'Capture refused';
    else try { message = String(e && e.message != null ? e.message : e).slice(0, 200); } catch (_) { message = 'unreadable error'; }
    if (lastRootScan.errors.length < 5) lastRootScan.errors.push({ rendererId: rendererId, phase: phase, message: message });
  }

  function rootScanCoverage(bounds) {
    var reasons = [];
    var registryIds = [];
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var renderers = hook && hook.renderers;
    if (bounds && bounds.private && !renderers) registryIds = null;
    if (renderers) {
      if (typeof renderers.keys !== 'function' || typeof renderers.forEach !== 'function') {
        registryIds = null;
      } else {
        try {
          var iterator = bounds && bounds.private ? Map.prototype.keys.call(renderers) : renderers.keys();
          if (!iterator || typeof iterator.next !== 'function') {
            registryIds = null;
          } else {
            var step;
            var iterations = 0;
            while (registryIds !== null) {
              if (bounds && Date.now() >= bounds.deadline) { registryIds = null; break; }
              step = iterator.next();
              if (!step || typeof step !== 'object' || typeof step.done !== 'boolean') {
                registryIds = null;
                break;
              }
              if (step.done) break;
              if (++iterations > MAX_REGISTERED_RENDERER_IDS || typeof step.value !== 'number') {
                registryIds = null;
                break;
              }
              if (registryIds.indexOf(step.value) === -1) registryIds.push(step.value);
              if (registryIds.length > MAX_REGISTERED_RENDERER_IDS) registryIds = null;
            }
          }
        } catch (_) {
          registryIds = null;
        }
        if (registryIds !== null && !(bounds && bounds.private)) {
          try {
            var forEachIterations = 0;
            renderers.forEach(function(_v, id) {
              if (registryIds === null) return;
              if (++forEachIterations > MAX_REGISTERED_RENDERER_IDS || typeof id !== 'number') {
                registryIds = null;
                return;
              }
              if (registryIds.indexOf(id) === -1) registryIds.push(id);
              if (registryIds.length > MAX_REGISTERED_RENDERER_IDS) registryIds = null;
            });
          } catch (_) {
            registryIds = null;
          }
        }
      }
    }
    var addReason = function(reason) {
      if (reasons.indexOf(reason) === -1) reasons.push(reason);
    };
    if (lastRootScan.rendererErrors > 0 || registryIds === null) addReason('renderer-error');
    if (!lastRootScan.finished) addReason('root-enumeration-incomplete');
    var unscannedRendererIds = [];
    if (registryIds !== null) {
      for (var i = 0; i < registryIds.length; i++) {
        var id = registryIds[i];
        if (!lastRootScan.visited[id]) unscannedRendererIds.push(id);
      }
      if (unscannedRendererIds.length > 0) addReason('renderers-unscanned');
    }
    return {
      reasons: reasons,
      registeredRendererIds: registryIds,
      unscannedRendererIds: unscannedRendererIds,
      erroredRendererIds: lastRootScan.erroredRendererIds.slice(0, MAX_REGISTERED_RENDERER_IDS),
      rendererErrors: lastRootScan.rendererErrors,
      extraRootsError: lastRootScan.extraRootsError === true,
      scanFinished: lastRootScan.finished === true,
      scanErrors: lastRootScan.errors.slice()
    };
  }

  // Read the renderer IDs React DevTools actually registered. A malformed or
  // overflowing iterator returns an empty list and is isolated from discovery.
  // Callers union successful results with the legacy numeric range so partial
  // hook-shim registries cannot hide otherwise discoverable roots.
  function getRegisteredRendererIds(hook) {
    try {
      if (!hook || !hook.renderers || typeof hook.renderers.keys !== 'function') return [];
      var iterator = hook.renderers.keys();
      if (!iterator || typeof iterator.next !== 'function') return [];
      var ids = [];
      var step;
      var iterations = 0;
      while (!(step = iterator.next()).done) {
        if (++iterations > MAX_REGISTERED_RENDERER_IDS) return [];
        var id = step.value;
        if (typeof id === 'number' && ids.indexOf(id) === -1) ids.push(id);
      }
      return ids;
    } catch (_) {
      return [];
    }
  }

  function findActiveRenderer(bounds) {
    lastRootScan = { rendererErrors: 0, erroredRendererIds: [], extraRootsError: false, visited: {}, finished: false, errors: [] };
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || typeof hook.getFiberRoots !== 'function') return null;
    var rendererIds = getRegisteredRendererIds(hook);
    var usingRegisteredIds = rendererIds.length > 0;
    for (var fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
      if (rendererIds.indexOf(fallbackId) === -1) rendererIds.push(fallbackId);
    }
    var emptyStreak = 0;
    for (var rii = 0; rii < rendererIds.length; rii++) {
      if (bounds && Date.now() >= bounds.deadline) return null;
      var ri = rendererIds[rii];
      lastRootScan.visited[ri] = true;
      try {
        var roots = hook.getFiberRoots(ri);
        if (roots && roots.size > 0) {
          return { rendererId: ri, roots: roots };
        }
        if (!usingRegisteredIds) {
          emptyStreak++;
          if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) return null;
        }
      } catch (e) {
        if (!usingRegisteredIds) emptyStreak++;
        lastRootScan.rendererErrors++;
        lastRootScan.erroredRendererIds.push(ri);
        scanError(ri, 'roots', e, bounds);
      }
    }
    lastRootScan.finished = true;
    return null;
  }

  // GH #126 Gap B — private primitive consolidating renderer-roots
  // iteration. Both forEachRootFiber and findAllRootFibers delegate
  // here. A truthy return from cb short-circuits iteration (matches
  // existing forEachRootFiber semantics — 0/false/'' continue).
  // Returns whatever cb returned, or null if cb never short-circuited.
  //
  // Per-renderer try/catch protects against one renderer's getFiberRoots
  // throwing during teardown/HMR/worklet init (Gemini A3, 2026-04-23,
  // conf 80) — a single bad renderer must not poison the union. The
  // extra-roots step (globalThis.__QAREN_EXTRA_ROOTS__) runs AFTER the
  // native renderer loop so user-registered portals stay lower priority
  // than React's own registry.
  function iterateAllRoots(cb, bounds) {
    lastRootScan = { rendererErrors: 0, erroredRendererIds: [], extraRootsError: false, visited: {}, finished: false, errors: [] };
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var rootVisits = 0;
    if (hook && typeof hook.getFiberRoots === 'function') {
      var rendererIds = getRegisteredRendererIds(hook);
      var usingRegisteredIds = rendererIds.length > 0;
      for (var fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
        if (rendererIds.indexOf(fallbackId) === -1) rendererIds.push(fallbackId);
      }
      var emptyStreak = 0;
      var abortedEarly = false;
      for (var rii = 0; rii < rendererIds.length; rii++) {
        if (bounds && Date.now() >= bounds.deadline) return null;
        var ri = rendererIds[rii];
        lastRootScan.visited[ri] = true;
        var roots;
        try {
          roots = hook.getFiberRoots(ri);
        } catch (e) {
          if (!usingRegisteredIds) emptyStreak++;
          lastRootScan.rendererErrors++;
          lastRootScan.erroredRendererIds.push(ri);
          scanError(ri, 'roots', e, bounds);
          continue;
        }
        try {
          if (roots && roots.size) {
            emptyStreak = 0;
            var it = roots.values();
            var v;
            while (!(v = it.next()).done) {
              if (bounds && (++rootVisits > 100 || Date.now() >= bounds.deadline)) return null;
              var current = bounds && bounds.private ? qaData(v.value, 'current') : v.value && v.value.current;
              if (bounds && bounds.private && (!current || typeof current !== 'object')) throw new Error('Capture refused');
              if (current) {
                var result = cb(current, ri, v.value);
                if (result) return result;
              }
            }
          } else if (!usingRegisteredIds) {
            emptyStreak++;
            if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) {
              abortedEarly = true;
              break;
            }
          }
        } catch (e) {
          if (!usingRegisteredIds) emptyStreak++;
          lastRootScan.rendererErrors++;
          lastRootScan.erroredRendererIds.push(ri);
          scanError(ri, 'walk', e, bounds);
        }
      }
      if (!abortedEarly) lastRootScan.finished = true;
    }
    // GH #126 Gap B — extra-roots step. Runs AFTER the native renderer
    // loop (above) so user-registered portals are lower priority than
    // React's own registry. Independent try/catch from the per-renderer
    // try/catch above — one bad resolver should not poison results we
    // already collected from React's renderers. Negative rendererId
    // (-1) marks extra-roots so consumers can distinguish them by
    // metadata if needed; the cb still gets the same (rootFiber,
    // rendererId) signature.
    try {
      var extraResolver = globalThis.__QAREN_EXTRA_ROOTS__;
      if (typeof extraResolver === 'function') {
        if (bounds && bounds.private) throw new Error('Capture refused');
        var instances = extraResolver();
        if (Array.isArray(instances)) {
          for (var i = 0; i < instances.length; i++) {
            if (bounds && (++rootVisits > 100 || Date.now() >= bounds.deadline)) {
              lastRootScan.finished = false;
              return null;
            }
            var extraFiber = extractFiberFromInstance(instances[i]);
            if (extraFiber) {
              var extraResult = cb(extraFiber, -1);
              if (extraResult) return extraResult;
            }
          }
        }
      }
    } catch (e) {
      // swallow — resolver bug must not break iteration
      lastRootScan.rendererErrors++;
      lastRootScan.extraRootsError = true;
      scanError(-1, 'extra-roots', e, bounds);
    }
    return null;
  }

  // Public generator-style iterator. Calls cb for each renderer-root
  // and extra-root; returns first truthy result, else null. See
  // iterateAllRoots() for the consolidated iteration logic.
  function forEachRootFiber(cb) {
    return iterateAllRoots(cb);
  }

  function findProviderStore(match) {
    return forEachRootFiber(function(rootFiber) {
      var stack = [rootFiber];
      var visits = 0;
      while (stack.length > 0 && visits < 50000) {
        var current = stack.pop();
        visits++;
        var name = current.type && (current.type.displayName || current.type.name);
        var result = match(name, current.memoizedProps);
        if (result) return result;
        if (current.sibling) stack.push(current.sibling);
        if (current.child) stack.push(current.child);
      }
      return null;
    });
  }

  // B143: public collector returning Array<{rendererId, fiber}> across
  // EVERY registered React renderer. findActiveRenderer returns only the
  // first non-empty renderer — typically LogBox (a tiny shell). The main
  // app tree often lives on a later rendererID (common with Bridgeless +
  // Reanimated, which register their own secondary renderer). Query tools
  // that must reach all user components use this helper, not
  // findActiveRenderer. Delegates the iteration to iterateAllRoots; the
  // collector cb explicitly returns null to never short-circuit.
  function findAllRootFibers(bounds) {
    var out = [];
    iterateAllRoots(function(rootFiber, rendererId, root) {
      out.push({ rendererId: rendererId, fiber: rootFiber, root: root });
      return null; // explicit — keep collecting, never short-circuit
    }, bounds);
    return out;
  }

  function navIsShellComposite(name) {
    return NAV_SHELL_WRAPPERS.indexOf(name) !== -1;
  }

  // GH #525 — does this root carry app content? Bounded DFS over composites: any
  // named composite outside the dev-shell allowlist is app content, as is a tree
  // too large to finish scanning. Host primitives and unnamed fibers are neutral,
  // so an empty or host-only root (the idle dev shell surface) carries none.
  function navRootWithoutAppContent(rootFiber) {
    var stack = [rootFiber];
    var visited = 0;
    while (stack.length > 0) {
      var node = stack.pop();
      if (!node) continue;
      if (++visited > NAV_SHELL_SCAN_MAX) return false;
      var nodeType = node.type;
      if (nodeType && typeof nodeType !== 'string') {
        var nodeName = nodeType.displayName || nodeType.name;
        if (nodeName && !navIsShellComposite(nodeName)) return false;
      }
      if (node.sibling) stack.push(node.sibling);
      if (node.child) stack.push(node.child);
    }
    return true;
  }

  function navAllRootsWithoutAppContent(roots) {
    for (var nsi = 0; nsi < roots.length; nsi++) {
      try {
        if (!navRootWithoutAppContent(roots[nsi].fiber)) return false;
      } catch (eShellProbe) {
        return false;
      }
    }
    return true;
  }

  // GH #525 — bundled-framework evidence for getNavState. Evaluated code cannot
  // require() by package name (Metro resolves only exact dev verboseNames), so
  // the proof is Metro's dev module registry: __r.getModules() maps module IDs
  // to definitions whose verboseName carries the bundled file path. Bounded and
  // fail-closed: no registry, a throwing registry, or nothing matched within
  // the bound degrade to null (the legacy message). A react-navigation match
  // found WITHIN the bound is still reported when the bound then trips —
  // positive evidence is monotone, and expo-router bundles @react-navigation/*
  // so the hedged message stays truthful even if expo-router sat past the cut.
  var NAV_MODULE_SCAN_MAX = 20000;

  function navFrameworkFromModuleName(name) {
    if (typeof name !== 'string') return null;
    if (name.indexOf('node_modules/expo-router/') !== -1) return 'expo-router';
    if (name.indexOf('node_modules/@react-navigation/') !== -1) return 'react-navigation';
    return null;
  }

  function navDetectBundledFramework() {
    try {
      var metroReq = globalThis.__r;
      if (!metroReq || typeof metroReq.getModules !== 'function') return null;
      var mods = metroReq.getModules();
      if (!mods) return null;
      var found = null;
      var seen = 0;
      if (typeof mods.values === 'function') {
        var iterator = mods.values();
        var step;
        while (!(step = iterator.next()).done) {
          if (++seen > NAV_MODULE_SCAN_MAX) return found;
          var hit = navFrameworkFromModuleName(step.value && step.value.verboseName);
          // expo-router bundles @react-navigation underneath — keep scanning
          // past a react-navigation hit so the more specific framework wins.
          if (hit === 'expo-router') return hit;
          if (hit) found = hit;
        }
      } else {
        // Legacy object registry: enumerate incrementally so the bound also
        // limits enumeration work, not just inspection.
        for (var key in mods) {
          if (!Object.prototype.hasOwnProperty.call(mods, key)) continue;
          if (++seen > NAV_MODULE_SCAN_MAX) return found;
          var hitObj = navFrameworkFromModuleName(mods[key] && mods[key].verboseName);
          if (hitObj === 'expo-router') return hitObj;
          if (hitObj) found = hitObj;
        }
      }
      return found;
    } catch (eNavFw) {
      return null;
    }
  }

  // GH #126 Gap B — convert a user-provided React component instance into
  // a fiber for iterateAllRoots() to walk. Three accepted shapes, tried
  // in order: (1) instance._reactInternals (modern React 16.8+ class
  // components and useImperativeHandle-exposed values), (2) instance.
  // _reactInternalFiber (legacy React), (3) already-a-fiber escape hatch
  // for advanced users — duck-typed by REQUIRING both 'return' and 'child'
  // as own/inherited keys (the dual requirement rejects generator-like
  // objects that only have .return). Returns null on any other input —
  // the caller treats null as "skip this entry," which is the silent
  // partial-failure isolation per spec §6.
  function extractFiberFromInstance(inst) {
    if (!inst || typeof inst !== 'object') return null;
    if (inst._reactInternals) return inst._reactInternals;
    if (inst._reactInternalFiber) return inst._reactInternalFiber;
    if ('return' in inst && 'child' in inst) return inst;
    return null;
  }

  // Sanitize an object by enumerating properties safely — getters that throw
  // (e.g. useNavigation context access outside NavigationContainer) would
  // normally crash JSON.stringify before the replacer runs.
  function sanitizeForSerialization(obj, seen, depth) {
    seen = seen || new WeakSet();
    depth = depth || 0;
    if (depth > 20) return '[MaxDepth]';
    if (obj === null || obj === undefined) return obj;
    var t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (t === 'function') return '[Function]';
    if (t === 'symbol') return obj.toString();
    if (t !== 'object') return '[Unserializable:' + t + ']';
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    if (obj instanceof Error) return { message: obj.message, stack: obj.stack };
    if (Array.isArray(obj)) {
      var arr = [];
      for (var i = 0; i < obj.length && i < 200; i++) {
        try { arr.push(sanitizeForSerialization(obj[i], seen, depth + 1)); }
        catch(e) { arr.push('[GetterError:' + (e && e.message || 'unknown') + ']'); }
      }
      return arr;
    }
    var out = {};
    var keys;
    try { keys = Object.keys(obj); }
    catch(e) { return '[UnenumerableKeys]'; }
    for (var k = 0; k < keys.length && k < 100; k++) {
      var key = keys[k];
      try {
        var val = obj[key]; // Getter can throw here
        out[key] = sanitizeForSerialization(val, seen, depth + 1);
      } catch(e) {
        out[key] = '[GetterError:' + (e && e.message && e.message.slice(0, 60) || 'unknown') + ']';
      }
    }
    return out;
  }

  function safeStringify(obj, maxLen) {
    try {
      var limit = maxLen || 50000;
      // Pre-sanitize to handle throwing getters (B90 Tier 4 fix)
      var sanitized = sanitizeForSerialization(obj);
      var str = JSON.stringify(sanitized);
      if (str && str.length > limit) {
        return JSON.stringify({
          __agent_truncated: true,
          originalLength: str.length,
          hint: 'State exceeds the payload budget; target a smaller component via testID, or read specific values via cdp_store_state / cdp_evaluate.'
        });
      }
      return str;
    } catch(e) {
      return JSON.stringify({ __agent_error: 'Serialization failed: ' + (e && e.message || String(e)) });
    }
  }

  // Interactive evidence is helper-built plain data with producer-owned bounds; never truncate it.
  function evidenceJson(out) {
    try {
      var json = JSON.stringify(out);
      return json.length > 999999 ? JSON.stringify({ __agent_truncated: true, originalLength: json.length }) : json;
    } catch (_) {
      return JSON.stringify({ __agent_error: 'Serialization failed' });
    }
  }

  function typographyHostType(fiber) {
    if (fiber.tag !== 5) return null;
    var state = fiber.stateNode;
    var config = state && (state.canonical ? state.canonical.viewConfig : state.viewConfig);
    var name = config && config.uiViewClassName;
    if (typeof name !== 'string') name = typeof fiber.type === 'string' ? fiber.type : null;
    return name && name.length <= 200 ? name : null;
  }

  // RN dev renderers deep-freeze host prop values into bound identity accessors.
  function descriptorValue(object, descriptor) {
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) return descriptor.value;
    var get = descriptor.get;
    var set = descriptor.set;
    var getName = typeof get === 'function' && Object.getOwnPropertyDescriptor(get, 'name');
    var setName = typeof set === 'function' && Object.getOwnPropertyDescriptor(set, 'name');
    if (!Object.isFrozen(object) || !getName || getName.value !== 'bound identity'
      || !setName || setName.value !== 'bound throwOnImmutableMutation') throw new Error('Capture refused');
    return Reflect.apply(get, object, []);
  }

  // Only nested public evidence may pass devFrozen; input facts stay data-only.
  function qaData(object, key, devFrozen) {
    if (object == null) return undefined;
    if (typeof object !== 'object' && typeof object !== 'function') throw new Error('Capture refused');
    var descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor && !(key in object)) return undefined;
    if (!descriptor || (devFrozen !== true && !Object.prototype.hasOwnProperty.call(descriptor, 'value'))) throw new Error('Capture refused');
    return descriptorValue(object, descriptor);
  }

  // A host view's touch facts, public and value-free, read like the display facts: devFrozen accepts the
  // dev renderer's frozen prop values. pointerEvents falls back to eligibilityPointerEvents and reads an
  // unknown or invalid value as auto (a cover); zIndexKnown false leaves the host without an order.
  var QA_POINTER_EVENTS = ['auto', 'none', 'box-none', 'box-only'];
  function qaStyleFact(style, key, depth) {
    if (style == null || style === false) return undefined;
    if (depth > 32) throw new Error('Capture refused');
    if (Array.isArray(style)) {
      var length = qaData(style, 'length', true);
      for (var i = length - 1; i >= 0; i--) {
        var value = qaStyleFact(qaData(style, String(i), true), key, depth + 1);
        if (value !== undefined) return value;
      }
      return undefined;
    }
    if (typeof style !== 'object') throw new Error('Capture refused');
    return qaData(style, key, true);
  }
  function qaTouchFacts(fiber) {
    var props = qaData(fiber, 'memoizedProps', true);
    var pointerEvents = null;
    try {
      pointerEvents = qaData(props, 'pointerEvents', true);
      if (pointerEvents == null) pointerEvents = qaStyleFact(qaData(props, 'style', true), 'pointerEvents', 0);
    } catch (_) {
      try { pointerEvents = eligibilityPointerEvents(fiber); } catch (_) { pointerEvents = null; }
    }
    if (QA_POINTER_EVENTS.indexOf(pointerEvents) === -1) pointerEvents = null;
    var zIndex = null;
    var zIndexKnown = true;
    try {
      zIndex = qaStyleFact(qaData(props, 'style', true), 'zIndex', 0);
      if (zIndex == null) zIndex = null;
      else if (typeof zIndex !== 'number' || !isFinite(zIndex)) zIndexKnown = false;
    } catch (_) { zIndexKnown = false; }
    return { pointerEvents: pointerEvents, zIndex: zIndexKnown ? zIndex : null, zIndexKnown: zIndexKnown };
  }

  function qaHostType(fiber) {
    var state = qaData(fiber, 'stateNode');
    var canonical = qaData(state, 'canonical');
    var config = qaData(canonical || state, 'viewConfig');
    var name = qaData(config, 'uiViewClassName');
    if (name != null && (typeof name !== 'string' || name.length > 200)) throw new Error('Capture refused');
    var type = qaData(fiber, 'type');
    return name || (typeof type === 'string' ? type : null);
  }

  function imageSourcePlaceholderFacts(fiber, props) {
    if (qaHostType(fiber) !== 'ViewManagerAdapter_ExpoImage') return null;
    var state = qaData(fiber, 'stateNode');
    var canonical = qaData(state, 'canonical');
    var config = qaData(canonical || state, 'viewConfig');
    if (qaData(config, 'uiViewClassName') !== 'ViewManagerAdapter_ExpoImage') return null;
    var attributes = qaData(config, 'validAttributes');
    var source = qaData(attributes, 'source');
    var placeholder = qaData(attributes, 'placeholder');
    var sourceProcess = source === true ? true : qaData(source, 'process');
    var placeholderProcess = placeholder === true ? true : qaData(placeholder, 'process');
    if (sourceProcess !== true && typeof sourceProcess !== 'function') return null;
    if (placeholderProcess !== true && typeof placeholderProcess !== 'function') return null;
    var roles = ['role', 'accessibilityRole'];
    for (var ri = 0; ri < roles.length; ri++) {
      var role = qaData(props, roles[ri]);
      if (role != null && (typeof role !== 'string' || ['textinput', 'textbox', 'search', 'searchbox'].indexOf(role.toLowerCase()) !== -1)) return null;
    }
    var inputProps = ['onChangeText', 'onChange', 'onEndEditing', 'onKeyPress', 'onSubmitEditing', 'editable', 'readOnly', 'aria-readonly'];
    for (var pi = 0; pi < inputProps.length; pi++) if (qaData(props, inputProps[pi]) != null) return null;
    return [config, attributes, source, placeholder, sourceProcess, placeholderProcess];
  }

  var qaCaptureSlot = null;
  var qaCaptureCounter = 0;

  function releaseQaCapture(slot) {
    if (!slot) return;
    clearTimeout(slot.timer);
    if (slot.capture) slot.capture.release();
    slot.capture = null;
    slot.tree = undefined;
    slot.state = 'refused';
    if (qaCaptureSlot === slot) qaCaptureSlot = null;
  }

  // A refusal carries only a fixed cause code and the producer's integer counters.
  function refuseQaCapture(slot, cause) {
    var source = slot.capture && slot.capture.diagnostic;
    var diagnostic = { cause: cause || (source && source.cause) || 'producer-refused' };
    var counters = ['scanned', 'budget', 'roots', 'hosts', 'interactive', 'queued', 'pruned'];
    for (var ci = 0; source && ci < counters.length; ci++) {
      if (typeof source[counters[ci]] === 'number') diagnostic[counters[ci]] = source[counters[ci]];
    }
    slot.state = 'refused';
    slot.diagnostic = diagnostic;
  }

  function readQaCapture(id) {
    var safeId = typeof id === 'string' && /^[a-f0-9]{1,32}$/.test(id) ? id : '0';
    var reply = { v: 1, id: safeId, state: 'refused' };
    var slot = qaCaptureSlot;
    if (!slot || slot.id !== safeId) return reply;
    if (Date.now() >= slot.expires) {
      refuseQaCapture(slot, 'producer-deadline');
      reply.diagnostic = slot.diagnostic;
      releaseQaCapture(slot);
      return reply;
    }
    reply.state = slot.state;
    if (slot.state === 'ready') reply.tree = slot.tree;
    if (slot.state === 'refused' && slot.diagnostic) reply.diagnostic = slot.diagnostic;
    if (slot.state !== 'pending') releaseQaCapture(slot);
    return reply;
  }

  function beginQaCapture(typography) {
    releaseQaCapture(qaCaptureSlot);
    qaCaptureCounter = (qaCaptureCounter + 1) % 0x100000000;
    var start = Date.now();
    var slot = { id: start.toString(16) + qaCaptureCounter.toString(16), state: 'pending', expires: start + 1500 };
    qaCaptureSlot = slot;
    // Marks a strict QA capture; it carries no input values.
    var inputs = { complete: false };
    function completed(tree) {
      if (qaCaptureSlot !== slot || !slot.capture) return;
      slot.state = slot.capture.accepted && typeof tree === 'string' && Date.now() < slot.capture.deadline ? 'ready' : 'refused';
      if (slot.state === 'ready') slot.tree = tree;
      else refuseQaCapture(slot, slot.capture.accepted && Date.now() >= slot.capture.deadline ? 'producer-deadline' : null);
      slot.capture.release();
      slot.capture = null;
    }
    try {
      slot.capture = createTypographyCapture(start, inputs, typography === true);
      slot.timer = setTimeout(function() { releaseQaCapture(slot); }, 1500);
      var tree = getTree({ interactiveOnly: true, semanticEvidence: true, typographyEvidence: typography === true }, slot.capture);
      if (slot.capture.renderError === true) {
        var terminal = { v: 1, id: slot.id, state: 'refused', reason: 'render-error' };
        releaseQaCapture(slot);
        return terminal;
      }
      if (tree && typeof tree.then === 'function') tree.then(completed, function() { completed(null); });
      else completed(tree);
      if (!inputs.complete) {
        if (slot.state !== 'refused') refuseQaCapture(slot, null);
        releaseQaCapture(slot);
      }
    } catch (_) {
      inputs.complete = false;
      refuseQaCapture(slot, 'producer-error');
      releaseQaCapture(slot);
    }
    if (slot.state === 'refused') { inputs.complete = false; releaseQaCapture(slot); }
    var reply = { v: 1, id: slot.id, state: slot.state };
    if (slot.state === 'ready') { reply.tree = slot.tree; releaseQaCapture(slot); }
    if (slot.state === 'refused' && slot.diagnostic) reply.diagnostic = slot.diagnostic;
    return reply;
  }

  function createTypographyCapture(start, privateInputs, measureTypography) {
    var deadline = start + 1000;
    var evidence = { version: 1, complete: true, durationMs: 0, coordinateSpace: 'window-points', nodes: [] };
    var records = new WeakMap();
    var captured = [];
    var hostRecords = [];
    var totalChars = 0;
    var textVisits = 0;
    var styleVisits = 0;
    var ownershipVisits = 0;
    var rendererExport;
    var rendererSearched = false;
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    var released = false;
    var cancel;
    var capture;
    var rendererCoverage;

    function propertyFacts(fiber) {
      var props = qaData(fiber, 'memoizedProps');
      // HostText and Fragment fibers carry their children as props; identity is the whole fact.
      if (props == null || typeof props !== 'object' || Array.isArray(props)) return [props];
      var keys = ['role', 'accessibilityRole', 'testID', 'nativeID', 'disabled', 'aria-disabled', 'editable', 'readOnly', 'aria-readonly', 'title', 'accessibilityLabel', 'placeholder', 'value', 'onPress', 'onPressIn', 'onLongPress', 'onChangeText', 'onValueChange', 'onChange', 'onSubmitEditing', 'onClick'];
      var values = [];
      for (var ki = 0; ki < keys.length; ki++) values.push(qaData(props, keys[ki]));
      values.push(qaData(qaData(props, 'accessibilityState'), 'disabled', true));
      var placeholder = qaData(props, 'placeholder');
      if (isHostFiber(fiber) && placeholder != null && typeof placeholder !== 'string') {
        values = values.concat(imageSourcePlaceholderFacts(fiber, props) || [null]);
      }
      return values;
    }

    function prepare(fiber) {
      if (!privateInputs) return;
      if (!fiber || typeof fiber !== 'object') throw new Error('Capture refused');
      var fields = ['memoizedProps', 'return', 'child', 'sibling', 'stateNode', 'type', 'tag', 'memoizedState'];
      for (var fi = 0; fi < fields.length; fi++) qaData(fiber, fields[fi]);
      if (isHostFiber(fiber)) qaHostType(fiber);
    }

    function nameOf(fiber) {
      var type = qaData(fiber, 'type');
      var seen = [];
      function data(object, key) {
        var descriptor = Object.getOwnPropertyDescriptor(object, key);
        return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value') ? descriptor.value : undefined;
      }
      try {
        for (var hop = 0; hop <= 2; hop++) {
          if (!type || (typeof type !== 'object' && typeof type !== 'function') || seen.indexOf(type) !== -1) return null;
          seen.push(type);
          var keys = ['displayName', 'name'];
          for (var ni = 0; ni < keys.length; ni++) {
            var name = data(type, keys[ni]);
            if (typeof name === 'string' && name.length > 0 && name.length <= 200) return name;
          }
          if (hop === 2) return null;
          var marker = data(type, '$$typeof');
          if (marker === Symbol.for('react.memo')) type = data(type, 'type');
          else if (marker === Symbol.for('react.forward_ref')) type = data(type, 'render');
          else return null;
        }
      } catch (_) {}
      return null;
    }

    function release() {
      released = true;
      if (cancel) { var stop = cancel; cancel = null; stop(); }
      captured.length = 0;
      hostRecords.length = 0;
      records = new WeakMap();
      privateInputs = null;
      hook = null;
      rendererExport = null;
    }

    function ownData(object, key) {
      if (!object || typeof object !== 'object') return undefined;
      var descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor ? descriptorValue(object, descriptor) : undefined;
    }

    function accessibilityFacts(props) {
      function fact(keys, boolean) {
        try {
          if (!props || typeof props !== 'object' || Array.isArray(props)) return 'unknown';
          var present = false;
          for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (!Object.getOwnPropertyDescriptor(props, key) && key in props) return 'unknown';
            var value = ownData(props, key);
            if (value == null) continue;
            if (boolean) return value === true ? 'true' : value === false ? 'false' : 'unknown';
            if (typeof value !== 'string') return 'unknown';
            if (value.length > 0) present = true;
          }
          return present ? 'present' : 'absent';
        } catch (_) { return 'unknown'; }
      }
      return {
        accessible: fact(['accessible'], true),
        authoredLabel: fact(['accessibilityLabel', 'aria-label', 'accessibilityLabelledBy', 'aria-labelledby'], false)
      };
    }

    function inactiveCssSelection(value, allowEmpty) {
      if (value === 'none') return true;
      if (!Array.isArray(value) || value.length > 128 || (!allowEmpty && value.length === 0)) return false;
      for (var i = 0; i < value.length; i++) {
        if (++ownershipVisits > 16384 || Date.now() >= deadline || ownData(value, String(i)) !== 'none') return false;
      }
      return true;
    }

    function configuredCssAnimation(style) {
      var animation = ownData(style, 'animationName');
      if (animation != null && !inactiveCssSelection(animation, true)) return true;
      var property = ownData(style, 'transitionProperty');
      var shorthand = ownData(style, 'transition');
      if (property !== undefined && !inactiveCssSelection(property, true)) return true;
      if (shorthand !== undefined && !inactiveCssSelection(shorthand, true)) return true;
      if (property !== undefined && shorthand !== undefined) {
        return !inactiveCssSelection(property, false) || !inactiveCssSelection(shorthand, false);
      }
      if (inactiveCssSelection(property, false) || inactiveCssSelection(shorthand, false)) return false;
      var settings = ['transitionDuration', 'transitionDelay', 'transitionTimingFunction', 'transitionBehavior'];
      for (var i = 0; i < settings.length; i++) {
        if (ownData(style, settings[i]) !== undefined) return true;
      }
      return false;
    }

    function animationFacts(value) {
      var pending = [{ value: value, depth: 0 }];
      var seen = new WeakSet();
      var visits = 0;
      while (pending.length) {
        if (++visits > 128 || ++ownershipVisits > 16384 || Date.now() >= deadline) return true;
        var item = pending.pop();
        var current = item.value;
        if (current == null || typeof current !== 'object') {
          if (typeof current === 'function') return true;
          continue;
        }
        if (item.depth > 16) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        // Original animation handles survive on owners even when native props contain only initial values.
        if ('viewDescriptors' in current || '_isReanimatedSharedValue' in current
          || '__getValue' in current || '__getAnimatedValue' in current) return true;
        if (Array.isArray(current)) {
          if (current.length > 128 || pending.length + current.length > 128) return true;
          for (var ai = current.length - 1; ai >= 0; ai--) pending.push({ value: ownData(current, String(ai)), depth: item.depth + 1 });
        } else {
          var proto = Object.getPrototypeOf(current);
          if (proto !== null && Object.getPrototypeOf(proto) !== null) return true;
          if (configuredCssAnimation(current)) return true;
          var keys = 0;
          for (var key in current) {
            if (++keys > 128 || pending.length >= 128) return true;
            var nested = ownData(current, key);
            if (nested !== null && (typeof nested === 'object' || typeof nested === 'function')) pending.push({ value: nested, depth: item.depth + 1 });
          }
        }
      }
      return false;
    }

    function animatedTypographyOwner(fiber) {
      try {
        var props = fiber.memoizedProps;
        var layoutFields = ['entering', 'exiting', 'layout'];
        for (var li = 0; li < layoutFields.length; li++) {
          var configuration = ownData(props, layoutFields[li]);
          if (configuration != null && configuration !== false) return true;
        }
        var fields = ['style', 'animatedProps', 'allowFontScaling', 'maxFontSizeMultiplier', 'adjustsFontSizeToFit', 'minimumFontScale', 'dynamicTypeRamp'];
        for (var pi = 0; pi < fields.length; pi++) {
          var value = ownData(props, fields[pi]);
          if (value != null && animationFacts(value)) return true;
        }
        if (fiber.tag === 1 && fiber.stateNode) {
          if (animationFacts(ownData(fiber.stateNode, '_animatedStyles'))
            || animationFacts(ownData(fiber.stateNode, '_animatedProps'))
            || animationFacts(ownData(fiber.stateNode, '_cssStyle'))
            || animationFacts(ownData(ownData(fiber.stateNode, '_InlinePropManager'), '_inlineProps'))) return true;
        }
        return false;
      } catch (_) { return true; }
    }

    function observe(fiber, frame, hostIndex) {
      var record = {
        fiber: fiber, props: fiber.memoizedProps, parent: fiber.return,
        child: fiber.child, sibling: fiber.sibling, state: fiber.stateNode,
        type: fiber.type, tag: fiber.tag, rootIndex: frame.rootIndex,
        hostIndex: hostIndex, hostType: typographyHostType(fiber),
        ancestryValid: fiber.return === frame.parentFiber || sameFiber(fiber.return, frame.parentFiber),
        childParent: fiber.child && fiber.child.return,
        siblingParent: fiber.sibling && fiber.sibling.return,
        animated: (!privateInputs || measureTypography) && (frame.animatedTypography === true || animatedTypographyOwner(fiber)),
        canonical: fiber.stateNode && fiber.stateNode.canonical
      };
      if (privateInputs) record.primitiveProps = propertyFacts(fiber);
      records.set(fiber, record);
      captured.push(record);
      if (hostIndex !== null && (!privateInputs || measureTypography)) {
        var node = {
          hostIndex: hostIndex, parentHostIndex: frame.parentHostIndex,
          rootIndex: frame.rootIndex, hostType: record.hostType, text: { kind: 'none' }
        };
        if (record.hostType !== 'RCTVirtualText') node.accessibility = accessibilityFacts(record.props);
        record.node = node;
        hostRecords.push(record);
        evidence.nodes.push(node);
        if (record.hostType === 'RCTVirtualText') {
          node.text = frame.textOwnerHostIndex === null
            ? { kind: 'unsupported' }
            : { kind: 'inline', ownerHostIndex: frame.textOwnerHostIndex };
        }
      }
      return record;
    }

    function textStyle(props, inherited) {
      var flattened = {};
      var keys = ['fontSize', 'fontSizeMultiplier', 'textTransform', 'transform', 'dynamicTypeRamp', 'allowFontScaling', 'maxFontSizeMultiplier'];
      var pending = [{ value: ownData(props, 'style'), depth: 0 }];
      var visits = 0;
      while (pending.length) {
        if (++visits > 128 || ++styleVisits > 8192 || Date.now() >= deadline) return null;
        var item = pending.pop();
        var value = item.value;
        if (value == null || value === false) continue;
        if (typeof value !== 'object' || item.depth > 16) return null;
        if (Array.isArray(value)) {
          if (value.length > 128 || pending.length + value.length > 128) return null;
          for (var ai = value.length - 1; ai >= 0; ai--) pending.push({ value: ownData(value, String(ai)), depth: item.depth + 1 });
        } else {
          var proto = Object.getPrototypeOf(value);
          if (proto !== null && Object.getPrototypeOf(proto) !== null) return null;
          if ('__getValue' in value || 'viewDescriptors' in value || 'initial' in value) return null;
          for (var ki = 0; ki < keys.length; ki++) {
            var descriptor = Object.getOwnPropertyDescriptor(value, keys[ki]);
            if (!descriptor) continue;
            try { flattened[keys[ki]] = descriptorValue(value, descriptor); } catch (_) { return null; }
          }
        }
      }
      if ((props.adjustsFontSizeToFit != null && props.adjustsFontSizeToFit !== false)
        || props.dynamicTypeRamp != null || props.minimumFontScale != null || props.fontSizeMultiplier != null
        || flattened.fontSizeMultiplier != null || flattened.dynamicTypeRamp != null
        || flattened.allowFontScaling != null || flattened.maxFontSizeMultiplier != null
        || (flattened.textTransform != null && flattened.textTransform !== 'none')
        || (flattened.transform != null && (!Array.isArray(flattened.transform) || flattened.transform.length !== 0))) return null;
      var size = flattened.fontSize == null ? inherited.fontSize : flattened.fontSize;
      var allow = props.allowFontScaling == null ? inherited.allowFontScaling : props.allowFontScaling;
      var max = props.maxFontSizeMultiplier == null ? inherited.maxFontSizeMultiplier : props.maxFontSizeMultiplier;
      if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0
        || typeof allow !== 'boolean' || typeof max !== 'number' || !Number.isFinite(max)
        || (max !== 0 && max < 1)) return null;
      return { fontSize: size, allowFontScaling: allow, maxFontSizeMultiplier: max };
    }

    function blockText(owner) {
      if (owner.animated) return { kind: 'unsupported' };
      // RN TextAttributes::defaultTextAttributes uses 14 points before scaling.
      var base = textStyle(owner.props || {}, { fontSize: 14, allowFontScaling: true, maxFontSizeMultiplier: 0 });
      if (!base) return { kind: 'unsupported' };
      var content = '';
      var runs = [];
      var stack = owner.child ? [{ fiber: owner.child, style: base }] : [];
      var visits = 0;
      var seen = new WeakSet();
      while (stack.length) {
        if (++visits > 256 || ++textVisits > 5000 || Date.now() >= deadline) return { kind: 'unsupported' };
        var entry = stack.pop();
        var record = records.get(entry.fiber);
        if (!record || record.animated || seen.has(entry.fiber) || record.rootIndex !== owner.rootIndex) return { kind: 'unsupported' };
        seen.add(entry.fiber);
        if (record.sibling) stack.push({ fiber: record.sibling, style: entry.style });
        var style = entry.style;
        if (record.tag === 6) {
          if (typeof record.props !== 'string' || record.child) return { kind: 'unsupported' };
          if (content.length + record.props.length > ${TYPOGRAPHY_TEXT_LIMITS.maxContentChars} || totalChars + record.props.length > ${TYPOGRAPHY_TEXT_LIMITS.maxTotalChars}) return { kind: 'unsupported' };
          if (record.props.length) {
            var last = runs[runs.length - 1];
            var end = content.length + record.props.length;
            if (last && last.fontSize === style.fontSize) last.end = end;
            else {
              if (runs.length >= 128) return { kind: 'unsupported' };
              runs.push({ start: content.length, end: end, fontSize: style.fontSize });
            }
            totalChars += record.props.length;
            content += record.props;
          }
        } else {
          if (isHostFiber(record.fiber)) {
            if (record.hostType !== 'RCTVirtualText') return { kind: 'unsupported' };
            style = textStyle(record.props || {}, style);
            if (!style || style.allowFontScaling !== base.allowFontScaling || style.maxFontSizeMultiplier !== base.maxFontSizeMultiplier) return { kind: 'unsupported' };
          } else if (record.tag === 4 || (record.tag === 22 && record.fiber.memoizedState != null)) return { kind: 'unsupported' };
          if (record.child) stack.push({ fiber: record.child, style: style });
        }
      }
      return { kind: 'block', content: content, runs: runs, scaling: { allowFontScaling: base.allowFontScaling, maxFontSizeMultiplier: base.maxFontSizeMultiplier } };
    }

    function findRendererExport() {
      if (rendererSearched) return rendererExport;
      rendererSearched = true;
      var metro = globalThis.__r;
      if (!metro || typeof metro.getModules !== 'function') return null;
      var modules = metro.getModules();
      if (!modules || typeof modules.values !== 'function') return null;
      var iterator = modules.values();
      for (var i = 0; i < 20000 && Date.now() < deadline; i++) {
        var step = iterator.next();
        if (step.done) return rendererExport;
        var mod = step.value;
        if (!mod || mod.isInitialized !== true || typeof mod.verboseName !== 'string') continue;
        if (!mod.verboseName.endsWith('/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js')) continue;
        var exports = mod.publicModule && mod.publicModule.exports;
        if (exports && typeof exports.getPublicInstanceFromInternalInstanceHandle === 'function') {
          if (rendererExport) return (rendererExport = null);
          rendererExport = exports;
        }
      }
      return (rendererExport = null);
    }

    function publicInstance(record) {
      if (record.tag !== 5) return null;
      var state = record.state;
      if (!state) return null;
      if (state.canonical) {
        if (state.canonical.publicInstance) return state.canonical.publicInstance;
        var exports = findRendererExport();
        return exports ? exports.getPublicInstanceFromInternalInstanceHandle(record.fiber) : null;
      }
      return state;
    }

    function unchanged(roots) {
      if (released || (privateInputs && Date.now() >= deadline)) return false;
      if (globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ !== hook) return false;
      var currentRoots = findAllRootFibers(privateInputs ? capture : { deadline: Infinity });
      if (!lastRootScan.finished || lastRootScan.rendererErrors || currentRoots.length !== roots.length) return false;
      if (privateInputs) {
        var coverage = rootScanCoverage(capture);
        if (coverage.reasons.length || JSON.stringify(coverage.registeredRendererIds) !== rendererCoverage) return false;
      }
      for (var ri = 0; ri < roots.length; ri++) {
        var root = roots[ri];
        if (!root.root || (privateInputs ? qaData(root.root, 'current') : root.root.current) !== root.fiber || root.rendererId < 0) return false;
        if (currentRoots[ri].fiber !== root.fiber || currentRoots[ri].rendererId !== root.rendererId) return false;
        if (privateInputs && currentRoots[ri].root !== root.root) return false;
      }
      for (var ci = 0; ci < captured.length; ci++) {
        if (privateInputs && Date.now() >= deadline) return false;
        var r = captured[ci];
        var f = r.fiber;
        prepare(f);
        if (privateInputs) {
          var primitiveProps = propertyFacts(f);
          for (var ppi = 0; ppi < primitiveProps.length; ppi++) if (primitiveProps[ppi] !== r.primitiveProps[ppi]) return false;
        }
        if (!r.ancestryValid || f.memoizedProps !== r.props || f.return !== r.parent || f.child !== r.child
          || f.sibling !== r.sibling || f.stateNode !== r.state || f.type !== r.type || f.tag !== r.tag
          || (r.child && (r.child.return !== r.childParent || !sameFiber(r.childParent, f)))
          || (r.sibling && (r.sibling.return !== r.siblingParent || (r.siblingParent !== r.parent && !sameFiber(r.siblingParent, r.parent))))
          || (f.stateNode && f.stateNode.canonical) !== r.canonical || typographyHostType(f) !== r.hostType) return false;
        if (r.node && r.node.accessibility && JSON.stringify(accessibilityFacts(r.props)) !== JSON.stringify(r.node.accessibility)) return false;
      }
      return true;
    }

    function finish(out, roots, budget, queued, pruned) {
      var verdictCause = out.verdict.complete ? null : 'verdict-reasons:' + (out.verdict.reasons.join(',') || 'incomplete');
      var typographyCause = evidence.complete ? null : capture.incompleteCause || 'typography-incomplete';
      capture.diagnostic = {
        cause: out.truncated ? 'truncated' : verdictCause || (out.hostEvidence.complete ? null : 'host-evidence-incomplete') || typographyCause,
        scanned: out.totalNodes,
        budget: budget,
        roots: roots.length,
        hosts: out.hostEvidence.hosts.length,
        interactive: out.interactive.length,
        queued: queued,
        pruned: pruned
      };
      evidence.complete = evidence.complete && out.hostEvidence.complete;
      if (privateInputs) {
        var coverage = rootScanCoverage(capture);
        rendererCoverage = JSON.stringify(coverage.registeredRendererIds);
        evidence.complete = evidence.complete && coverage.reasons.length === 0;
        if (!capture.diagnostic.cause && coverage.reasons.length) capture.diagnostic.cause = 'verdict-reasons:' + coverage.reasons.join(',');
        privateInputs.complete = evidence.complete;
        if (!measureTypography) {
          capture.accepted = privateInputs.complete && unchanged(roots);
          if (privateInputs.complete && !capture.accepted) capture.diagnostic.cause = Date.now() >= deadline ? 'producer-deadline' : 'tree-changed';
          privateInputs.complete = capture.accepted;
          return capture.accepted ? evidenceJson(out) : null;
        }
      }
      var tasks = [];
      for (var hi = 0; hi < hostRecords.length; hi++) {
        var record = hostRecords[hi];
        try {
          if (record.hostType === 'RCTText') record.node.text = blockText(record);
          record.requiredMeasurement = record.hostType === 'RCTText' || typeof out.hostEvidence.hosts[hi].testID === 'string';
          if (record.hostType !== 'RCTVirtualText') tasks.push(record);
        } catch (_) { record.node.text = { kind: 'unsupported' }; evidence.complete = false; }
      }
      record = null;
      out.hostEvidence.typography = evidence;
      return new Promise(function(resolve) {
        var next = 0;
        var active = 0;
        var done = false;
        var timer;
        function settle(timedOut) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          cancel = null;
          if (released) { roots = []; tasks = []; resolve(null); return; }
          if (timedOut) evidence.complete = false;
          var stable = false;
          try { stable = unchanged(roots); } catch (_) {}
          roots = [];
          tasks = [];
          if (privateInputs) capture.accepted = privateInputs.complete && stable && !timedOut && Date.now() < deadline;
          if (privateInputs && privateInputs.complete && !capture.accepted) capture.diagnostic.cause = timedOut || Date.now() >= deadline ? 'producer-deadline' : 'tree-changed';
          if (!stable) {
            evidence.complete = false;
            for (var ni = 0; ni < evidence.nodes.length; ni++) {
              var node = evidence.nodes[ni];
              delete node.rect;
              if (node.text.kind !== 'none') node.text = { kind: 'unsupported' };
            }
          }
          evidence.durationMs = Math.max(0, Date.now() - start);
          if (evidence.durationMs >= 1000) evidence.complete = false;
          resolve(evidenceJson(out));
        }
        function measure(record, measurementIndex) {
          var called = false;
          function complete(x, y, width, height) {
            if (called || done) return;
            called = true;
            if (Date.now() >= deadline) { settle(true); return; }
            var measured = hostRecords[measurementIndex];
            if (!measured) { settle(true); return; }
            if ([x, y, width, height].every(function(v) { return typeof v === 'number' && Number.isFinite(v); }) && width >= 0 && height >= 0) {
              measured.node.rect = { x: x, y: y, width: width, height: height };
              if (measured.requiredMeasurement && (width === 0 || height === 0)) evidence.complete = false;
            } else if (measured.requiredMeasurement) evidence.complete = false;
            active--;
            Promise.resolve().then(pump);
          }
          try {
            var instance = publicInstance(record);
            if (Date.now() >= deadline) { settle(true); return; }
            var owner = instance;
            var method;
            for (var depth = 0; owner && depth < 8; depth++, owner = Object.getPrototypeOf(owner)) {
              var descriptor = Object.getOwnPropertyDescriptor(owner, 'measureInWindow');
              if (descriptor) { method = descriptor.value; break; }
            }
            if (typeof method === 'function') method.call(instance, complete);
            else complete();
          } catch (_) { complete(); }
          finally { record = null; instance = null; owner = null; method = null; descriptor = null; }
        }
        function pump() {
          if (done) return;
          if (Date.now() >= deadline) { settle(true); return; }
          while (!done && active < 8 && next < tasks.length) {
            active++;
            var task = tasks[next++];
            measure(task, hostRecords.indexOf(task));
          }
          if (!done && next === tasks.length && active === 0) settle(false);
        }
        timer = setTimeout(function() { settle(true); }, Math.max(0, deadline - Date.now()));
        cancel = function() { settle(true); };
        pump();
      });
    }
    capture = { prepare: prepare, nameOf: nameOf, observe: observe, finish: finish, evidence: evidence, deadline: deadline, start: start, private: !!privateInputs, accepted: false, release: release };
    return capture;
  }

  // Fiber Tree Walker
  function getTree(opts, privateCapture) {
    opts = opts || {};
    var typography = privateCapture || (opts.interactiveOnly === true && opts.semanticEvidence === true && opts.typographyEvidence === true
      ? createTypographyCapture(Date.now()) : null);
    function earlyTree(out) {
      if (!typography) return JSON.stringify(out);
      if (out.verdict) typography.diagnostic = { cause: 'verdict-reasons:' + (out.verdict.reasons.join(',') || 'incomplete') };
      out.hostEvidence.typography = typography.evidence;
      typography.evidence.complete = false;
      typography.evidence.durationMs = Math.max(0, Date.now() - typography.start);
      return Promise.resolve(JSON.stringify(out));
    }
    var maxDepth = opts.maxDepth || 4;
    var filter = opts.filter || opts.testID || opts.type || null;

    // Story 16 (#409): quality verdict computed once at capture, from the same
    // pass that produced the tree — downstream tools render it, never re-derive.
    var walkQuality = { droppedSubtrees: 0, collapsedChildLists: 0 };
    function buildVerdict(path, o) {
      o = o || {};
      var reasons = [];
      if (o.noRenderer) reasons.push('no-renderer');
      var coverage = rootScanCoverage(privateCapture);
      for (var coverageIndex = 0; coverageIndex < coverage.reasons.length; coverageIndex++) {
        if (reasons.indexOf(coverage.reasons[coverageIndex]) === -1) {
          reasons.push(coverage.reasons[coverageIndex]);
        }
      }
      if (o.scanBudgetExhausted) reasons.push('scan-budget-exhausted');
      if (o.outputTruncated) reasons.push('output-truncated');
      var state = (o.noRenderer || o.failed) ? 'failed' : (reasons.length > 0 ? 'degraded' : 'ok');
      return {
        state: state,
        path: path,
        reasons: reasons,
        rootsSeeded: o.rootsSeeded || 0,
        scannedNodes: o.scannedNodes || 0,
        effectiveDepth: maxDepth,
        droppedSubtrees: walkQuality.droppedSubtrees,
        collapsedChildLists: walkQuality.collapsedChildLists,
        complete: state === 'ok' && reasons.length === 0 && walkQuality.droppedSubtrees === 0 && walkQuality.collapsedChildLists === 0,
        rendererErrors: lastRootScan.rendererErrors,
        unscannedRendererIds: coverage.unscannedRendererIds
      };
    }

    var renderer = findActiveRenderer(typography);
    if (!renderer) {
      return earlyTree({
        error: 'React DevTools hook not available or no fiber roots — app may still be loading',
        verdict: buildVerdict('none', { noRenderer: true }),
        hostEvidence: opts.interactiveOnly && opts.semanticEvidence === true ? { hosts: [], complete: false } : undefined
      });
    }

    var visited = new WeakSet();
    var totalNodes = 0;

    // Records the first fixed site that left typography evidence incomplete.
    function typographyIncomplete(cause) {
      typography.evidence.complete = false;
      if (!typography.incompleteCause) typography.incompleteCause = cause;
    }

    // A failed safe read never skips: it only means this fiber is walked as before.
    function routeRead(object, key) {
      try { return qaData(object, key, true); } catch (e) { return undefined; }
    }
    var UNKNOWN_DISPLAY = {};
    var MISSING_DISPLAY = {};
    function styleRead(object, key) {
      try { return key in object ? qaData(object, key, true) : MISSING_DISPLAY; } catch (e) { return UNKNOWN_DISPLAY; }
    }
    function resolvedDisplay(style, depth) {
      if (style === UNKNOWN_DISPLAY) return UNKNOWN_DISPLAY;
      if (style === MISSING_DISPLAY || !style || typeof style !== 'object') return MISSING_DISPLAY;
      if (depth > 16) return UNKNOWN_DISPLAY;
      if (Array.isArray(style)) {
        var shown = MISSING_DISPLAY;
        for (var di = 0; di < style.length; di++) {
          if (di >= 64) return UNKNOWN_DISPLAY;
          var part = resolvedDisplay(styleRead(style, String(di)), depth + 1);
          if (part !== MISSING_DISPLAY) shown = part;
        }
        return shown;
      }
      return styleRead(style, 'display');
    }
    // Only proven off-screen content can be pruned from the digest and typography overlay scan.
    function inactiveRoute(fiber) {
      var props = routeRead(fiber, 'memoizedProps');
      if (!props || typeof props !== 'object') return false;
      var inactive = routeRead(props, 'activityState') === 0;
      var invisible = routeRead(props, 'visible') === false;
      if (inactive || invisible) {
        var routeName = getName(fiber) || '';
        var routeBase = routeName.slice(routeName.lastIndexOf('.') + 1);
        if (inactive && (routeBase === 'Screen' || routeBase === 'InnerScreen' || routeBase === 'RNSScreen')) return true;
        if (invisible && (routeBase === 'MaybeScreen' || routeBase === 'ScreenContainer')) return true;
      }
      return isHostFiber(fiber) && resolvedDisplay(routeRead(props, 'style'), 0) === 'none';
    }

    var typographyOverlayVisits = 0;
    function hasErrorOverlay(fiber, depth) {
      if (typography) {
        var pending = [fiber];
        var overlaySeen = new WeakSet();
        while (pending.length) {
          if (++typographyOverlayVisits > 5000 || Date.now() >= typography.deadline) { typographyIncomplete(typographyOverlayVisits > 5000 ? 'overlay-scan-cap' : 'typography-deadline'); return false; }
          var node = pending.pop();
          if (!node || overlaySeen.has(node)) continue;
          overlaySeen.add(node);
          typography.prepare(node);
          var nodeName = getName(node);
          if (nodeName === 'LogBox' || nodeName === 'ErrorWindow' || nodeName === 'RedBox') return true;
          if (pending.length >= 5000) { typographyIncomplete('overlay-scan-cap'); return false; }
          if (node.child && !inactiveRoute(node)) pending.push(node.child);
          if (node.sibling) pending.push(node.sibling);
        }
        return false;
      }
      var current = fiber;
      while (current) {
        if ((depth || 0) > 15) return false;
        var name = current.type && (current.type.displayName || current.type.name);
        if (name === 'LogBox' || name === 'ErrorWindow' || name === 'RedBox') return true;
        if (current.child && hasErrorOverlay(current.child, (depth || 0) + 1)) return true;
        current = current.sibling;
      }
      return false;
    }

    // Error overlays can occupy a separate renderer root, so every root must be checked.
    var overlayRoots = findAllRootFibers(typography);
    var overlayFound = false;
    for (var oi = 0; oi < overlayRoots.length && !overlayFound; oi++) {
      if (hasErrorOverlay(overlayRoots[oi].fiber)) overlayFound = true;
    }
    if (overlayFound) {
      if (privateCapture) privateCapture.renderError = true;
      return earlyTree({
        warning: 'APP_HAS_REDBOX',
        message: 'App is showing an error screen. Use cdp_error_log to read the error, fix the code, then cdp_reload.',
        hostEvidence: opts.interactiveOnly && opts.semanticEvidence === true ? { hosts: [], complete: false } : undefined
      });
    }

    function getName(fiber) {
      if (privateCapture) return privateCapture.nameOf(fiber);
      if (!fiber || !fiber.type) return null;
      return fiber.type.displayName || fiber.type.name || null;
    }

    function walkSubtree(fiber, depth, limit, vis) {
      if (!fiber) return null;
      if (depth > limit) {
        // Depth-cap drop: expected under the requested cap, but must be
        // counted — a sparse-because-shallow tree previously looked identical
        // to a legitimately small one.
        walkQuality.droppedSubtrees++;
        return null;
      }
      if (vis.has(fiber)) return null;
      vis.add(fiber);
      totalNodes++;

      if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') {
        return { text: fiber.memoizedProps };
      }

      var name = getName(fiber);
      var testID = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.nativeID);
      var accessibilityLabel = fiber.memoizedProps && fiber.memoizedProps.accessibilityLabel;
      var isUserComponent = name && !name.startsWith('RCT') && /^[A-Z]/.test(name);
      var fiberDisabled = fiber.memoizedProps && (fiber.memoizedProps.disabled === true || fiber.memoizedProps.editable === false || (fiber.memoizedProps.accessibilityState && fiber.memoizedProps.accessibilityState.disabled === true));

      var children = [];
      var child = fiber.child;
      while (child) {
        var node = walkSubtree(child, isUserComponent ? depth + 1 : depth, limit, vis);
        if (node) children.push(node);
        child = child.sibling;
      }

      if (!isUserComponent && !testID) {
        if (children.length === 1) return children[0];
        if (children.length === 0) return null;
        return { _wrapper: true, children: children };
      }

      var result = { component: name };
      if (testID) result.testID = testID;
      if (accessibilityLabel) result.accessibilityLabel = accessibilityLabel;
      if (testID && fiberDisabled) result.disabled = true;

      if (isUserComponent && fiber.memoizedProps) {
        var props = {};
        var propKeys = Object.keys(fiber.memoizedProps);
        for (var i = 0; i < propKeys.length; i++) {
          var k = propKeys[i];
          if (k === 'children' || k === 'testID' || k === 'style' || k === 'accessibilityLabel' || k === 'nativeID') continue;
          if (k === 'value' || k === 'text' || k === 'defaultValue' || k === 'secureTextEntry') {
            var inputDescriptor = Object.getOwnPropertyDescriptor(fiber.memoizedProps, k);
            if (k === 'value' && inputDescriptor && Object.prototype.hasOwnProperty.call(inputDescriptor, 'value') && typeof inputDescriptor.value === 'boolean') props[k] = inputDescriptor.value;
            continue;
          }
          var v = fiber.memoizedProps[k];
          if (typeof v === 'function') { props[k] = '[Function]'; continue; }
          if (Array.isArray(v)) { props[k] = '[Array(' + v.length + ')]'; continue; }
          if (typeof v === 'object' && v !== null) {
            try {
              var objKeys = Object.keys(v);
              props[k] = objKeys.length > 5
                ? '{' + objKeys.slice(0, 5).join(', ') + ', ...(' + (objKeys.length - 5) + ' more)}'
                : '{' + objKeys.join(', ') + '}';
            } catch(e) { props[k] = '[Object]'; }
            continue;
          }
          try {
            var s = JSON.stringify(v);
            props[k] = s && s.length > 200 ? s.substring(0, 200) + '...' : v;
          } catch(e) { props[k] = '[Unserializable]'; }
        }
        if (Object.keys(props).length > 0) result.props = props;
      }

      if (children.length > 0) {
        if (children.length > 20) walkQuality.collapsedChildLists++;
        result.children = children.length > 20
          ? children.slice(0, 10).concat([{ _truncated: (children.length - 10) + ' more' }])
          : children;
      }

      return result;
    }

    // Compact actionable nodes across every renderer root.
    if (opts.interactiveOnly) {
      var INTERACTIVE_NAMES = { Pressable: 1, TouchableOpacity: 1, TouchableHighlight: 1, TouchableWithoutFeedback: 1, TouchableNativeFeedback: 1, Button: 1, TextInput: 1, Switch: 1, Link: 1 };
      var INTERACTIVE_ROLES = { button: 1, link: 1, switch: 1, checkbox: 1, radio: 1, menuitem: 1, tab: 1, togglebutton: 1, imagebutton: 1, search: 1, adjustable: 1 };
      var HANDLER_PROPS = ['onPress', 'onPressIn', 'onLongPress', 'onChangeText', 'onValueChange', 'onChange', 'onSubmitEditing', 'onClick'];

      var digestPropsCache = new WeakMap();
      function digestProps(fiber) {
        var props = fiber.memoizedProps;
        if (!typography) return props;
        if (digestPropsCache.has(fiber)) return digestPropsCache.get(fiber);
        var safe = {};
        digestPropsCache.set(fiber, safe);
        if (!props || typeof props !== 'object') return safe;
        var keys = HANDLER_PROPS.concat(['role', 'accessibilityRole', 'testID', 'nativeID', 'disabled', 'aria-disabled', 'accessibilityState', 'editable', 'readOnly', 'aria-readonly', 'title', 'accessibilityLabel', 'placeholder', 'value', 'aria-hidden', 'accessibilityElementsHidden', 'importantForAccessibility']);
        for (var i = 0; i < keys.length; i++) {
          try {
            var value = qaData(props, keys[i]);
            if (['role', 'accessibilityRole', 'testID', 'nativeID', 'title', 'accessibilityLabel', 'placeholder'].indexOf(keys[i]) !== -1 && value != null && typeof value !== 'string') {
              if (!isHostFiber(fiber) && ['title', 'accessibilityLabel', 'placeholder'].indexOf(keys[i]) !== -1) continue;
              if (keys[i] === 'placeholder' && isHostFiber(fiber) && imageSourcePlaceholderFacts(fiber, props)) continue;
              throw new Error('Opaque digest string');
            }
            if (keys[i] === 'accessibilityState' && value && typeof value === 'object') value = { disabled: qaData(value, 'disabled', true) };
            safe[keys[i]] = value;
          } catch (_) { typographyIncomplete('digest-prop-opaque'); }
        }
        return safe;
      }

      var isInteractiveFiber = function(fiber) {
        var props = digestProps(fiber);
        if (!props || typeof props !== 'object') return false;
        var nm = getName(fiber);
        if (nm && INTERACTIVE_NAMES[nm]) return true;
        var role = props.accessibilityRole;
        if (role && INTERACTIVE_ROLES[String(role).toLowerCase()]) return true;
        for (var hi = 0; hi < HANDLER_PROPS.length; hi++) {
          if (typeof props[HANDLER_PROPS[hi]] === 'function') return true;
        }
        return false;
      };

      var inferRole = function(nm, props) {
        if (props && props.accessibilityRole) return String(props.accessibilityRole).toLowerCase();
        if (nm === 'TextInput') return 'textinput';
        if (nm === 'Switch') return 'switch';
        if (nm === 'Link') return 'link';
        if (nm === 'Button' || nm === 'Pressable' || (nm && nm.indexOf('Touchable') === 0)) return 'button';
        if (props) {
          if (typeof props.onChangeText === 'function') return 'textinput';
          if (typeof props.onValueChange === 'function') return 'switch';
        }
        return 'button';
      };

      // Gather descendant text (capped), NOT recursing into nested interactive
      // nodes (they each get their own entry).
      var collectText = function(fiber, depth, acc) {
        if (!fiber || depth > 8 || acc.s.length >= 120 || inactiveRoute(fiber)) return;
        if (typography && (++typographyDigestVisits > 5000 || Date.now() >= typography.deadline)) { typographyIncomplete(typographyDigestVisits > 5000 ? 'digest-visit-cap' : 'typography-deadline'); return; }
        if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') {
          var t = fiber.memoizedProps.trim();
          if (t) acc.s += (acc.s ? ' ' : '') + t;
          return;
        }
        var c = fiber.child;
        while (c && acc.s.length < 120) {
          if (typography && (++typographyDigestVisits > 5000 || Date.now() >= typography.deadline)) { typographyIncomplete(typographyDigestVisits > 5000 ? 'digest-visit-cap' : 'typography-deadline'); break; }
          if (!isInteractiveFiber(c)) collectText(c, depth + 1, acc);
          c = c.sibling;
        }
      };

      var salient = [];
      var typographyDigestVisits = 0;
      var hostEvidence = opts.semanticEvidence === true ? { hosts: [], complete: true } : null;
      var hostRoles = 'adjustable alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group header heading image imagebutton img insertion keyboardkey link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript summary superscript switch tab table tablist tabpanel term text textbox time timer togglebutton toolbar tooltip tree treegrid treeitem'.split(' ');
      function collectHostEvidence(fiber) {
        if (!hostEvidence || !isHostFiber(fiber)) return null;
        if (hostEvidence.hosts.length >= ${PRIVATE_INPUT_LIMITS.maxHosts}) return null;
        var props = digestProps(fiber) || {};
        var source = props.role != null ? 'role' : props.accessibilityRole != null ? 'accessibilityRole' : 'none';
        var host = { role: null, roleSource: source, capabilities: {} };
        if (source !== 'none') {
          if (typeof props[source] === 'string' && hostRoles.indexOf(props[source]) !== -1) host.role = normalizeRole(props[source]);
          else hostEvidence.complete = false;
        }
        var identities = ['testID', 'nativeID'];
        for (var identityIndex = 0; identityIndex < identities.length; identityIndex++) {
          var origin = identities[identityIndex];
          if (props[origin] == null) continue;
          if (typeof props[origin] === 'string') host[origin] = props[origin];
          else hostEvidence.complete = false;
        }
        if (typeof props.onPress === 'function' || typeof props.onClick === 'function') host.capabilities.press = true;
        if (props.disabled === true || props['aria-disabled'] === true || (props.accessibilityState && props.accessibilityState.disabled === true)) host.disabled = true;
        if (props.editable === false || props.readOnly === true || props['aria-readonly'] === true) host.readOnly = true;
        if ((privateCapture ? HOST_KIND_LOOKUP[qaHostType(fiber)] : hostKind(fiber)) === 'textinput'
          && (props.editable == null || props.editable === true)
          && (props.readOnly == null || props.readOnly === false)
          && (props['aria-readonly'] == null || props['aria-readonly'] === false)) host.capabilities.fill = true;
        // An unreadable zIndex (a registered style id, say) leaves this host without an order: the core
        // cannot rank it among its siblings, so a hit its subtree could take stays unresolved.
        var touchKnown = false;
        try {
          var touch = qaTouchFacts(fiber);
          if (touch.pointerEvents !== null) host.pointerEvents = touch.pointerEvents;
          if (touch.zIndex !== null) host.zIndex = touch.zIndex;
          touchKnown = touch.zIndexKnown;
        } catch (_) {}
        hostEvidence.hosts.push(host);
        hostTouchKnown[hostEvidence.hosts.length - 1] = touchKnown;
        if (hostEvidence.hosts.length === ${PRIVATE_INPUT_LIMITS.maxHosts}) hostEvidence.complete = false;
        return hostEvidence.hosts.length - 1;
      }
      var iRoots = findAllRootFibers(typography);
      var iBudget = privateCapture ? 5000 : Math.min(5000, 2000 * Math.max(1, iRoots.length));
      var iQueue = [];
      // Each host's sibling-index path from its parent host (or its root) orders host siblings in fiber
      // order, which the breadth-first host indices do not; ranked into host.order after the scan.
      var hostOrderPaths = [];
      var hostOrderParents = [];
      var hostTouchKnown = [];
      for (var iri = 0; iri < iRoots.length; iri++) iQueue.push({ fiber: iRoots[iri].fiber, forwarded: null, parentFiber: null, parentHostIndex: null, textOwnerHostIndex: null, rootIndex: iri, orderPath: hostEvidence ? [iri] : null });
      var iSeen = new WeakSet();
      var iScanned = 0;
      var iStart = Date.now();
      var iEnqueued = iQueue.length;
      var iEnqueueTruncated = false;
      var iPruned = 0;
      while (iQueue.length > 0 && iScanned < iBudget && (Date.now() - iStart) < 3000 && (!typography || Date.now() < typography.deadline) && salient.length < 200) {
        var iframe = iQueue.shift();
        var ifiber = iframe.fiber;
        if (!ifiber || iSeen.has(ifiber)) continue;
        iSeen.add(ifiber);
        iScanned++;
        if (inactiveRoute(ifiber)) { iPruned++; continue; }
        if (typography) typography.prepare(ifiber);
        var hostIndex = collectHostEvidence(ifiber);
        if (hostIndex !== null) {
          hostOrderPaths[hostIndex] = iframe.orderPath;
          hostOrderParents[hostIndex] = iframe.parentHostIndex;
        }
        var typographyRecord = typography ? typography.observe(ifiber, iframe, hostIndex) : null;
        var iprops = digestProps(ifiber) || {};
        // A host view hiding its subtree from accessibility keeps that subtree out of the native tree.
        var hidden = iframe.hidden === true || (isHostFiber(ifiber) && (iprops['aria-hidden'] === true || iprops.accessibilityElementsHidden === true || iprops.importantForAccessibility === 'no-hide-descendants'));
        if (hidden && hostIndex !== null) hostEvidence.hosts[hostIndex].hidden = true;
        var itid = iprops.testID || iprops.nativeID;
        var forwarded = iframe.forwarded;
        var wrapperCandidate = iframe.wrapperCandidate;
        var inputAncestors = iframe.inputAncestors || [];
        if (hostIndex !== null && hostEvidence.hosts[hostIndex].capabilities.fill === true) {
          for (var ai = 0; ai < inputAncestors.length; ai++) {
            var ancestor = inputAncestors[ai];
            if (!ancestor.inputHostIndices) ancestor.inputHostIndices = [];
            ancestor.inputHostIndices.push(hostIndex);
          }
        }
        if (forwarded && itid && (forwarded.testID || forwarded.nativeID) !== itid) forwarded = null;
        var interactive = isInteractiveFiber(ifiber);
        if (interactive) {
          var entry = { role: inferRole(getName(ifiber), iprops) };
          entry.capabilities = {
            press: typeof iprops.onPress === 'function' || typeof iprops.onClick === 'function',
            fill: iprops.editable !== false && (getName(ifiber) === 'TextInput' || typeof iprops.onChangeText === 'function')
          };
          var handled = entry.capabilities.fill;
          for (var hj = 0; hj < HANDLER_PROPS.length; hj++) {
            if (typeof iprops[HANDLER_PROPS[hj]] === 'function') handled = true;
          }
          if (!handled) entry.handlerless = true;
          if (hidden) entry.hidden = true;
          if (iprops.testID) entry.testID = iprops.testID;
          else if (iprops.nativeID) entry.nativeID = iprops.nativeID;
          var acc = { s: '' };
          collectText(ifiber, 0, acc);
          if (acc.s) entry.text = acc.s.length > 120 ? acc.s.substring(0, 120) : acc.s;
          else if (iprops.title) entry.text = String(iprops.title); // RN <Button title> has no child text fiber
          if (iprops.accessibilityLabel) entry.label = String(iprops.accessibilityLabel);
          if (iprops.placeholder) entry.placeholder = String(iprops.placeholder);
          // surface on/off state for toggles so the agent need not re-read before deciding
          if (entry.role === 'switch' && typeof iprops.value === 'boolean') entry.value = iprops.value;
          if (iprops.disabled === true || iprops.editable === false || (iprops.accessibilityState && iprops.accessibilityState.disabled === true)) entry.disabled = true;
          if (itid && forwarded && (forwarded.testID || forwarded.nativeID) === itid && forwarded.role === entry.role) {
            var forwardedFields = ['text', 'label', 'placeholder', 'value'];
            for (var fi = 0; fi < forwardedFields.length; fi++) {
              var field = forwardedFields[fi];
              if (forwarded[field] === undefined && entry[field] !== undefined) forwarded[field] = entry[field];
            }
            forwarded.capabilities.press = forwarded.capabilities.press || entry.capabilities.press;
            forwarded.capabilities.fill = forwarded.capabilities.fill || entry.capabilities.fill;
            if (!entry.handlerless) delete forwarded.handlerless;
            if (entry.disabled) forwarded.disabled = true;
            if (entry.hidden) forwarded.hidden = true;
          } else {
            salient.push(entry);
            forwarded = entry;
            if (wrapperCandidate) wrapperCandidate.compositeWrapper = true;
            var componentName = getName(ifiber);
            var baseName = componentName && componentName.slice(componentName.lastIndexOf('.') + 1);
            wrapperCandidate = !isHostFiber(ifiber) && baseName && baseName !== 'View' && baseName !== 'RCTView'
              && !HOST_KIND_LOOKUP[baseName] && !INTERACTIVE_NAMES[baseName] && !iprops.role && !iprops.accessibilityRole ? entry : null;
            if (wrapperCandidate || (!isHostFiber(ifiber) && itid)) inputAncestors = inputAncestors.concat([entry]);
            if (hostIndex !== null && hostEvidence.hosts[hostIndex].capabilities.fill === true) entry.inputHostIndices = [hostIndex];
          }
        }
        var ich = ifiber.child;
        // Only a single-child chain of composites or identity-less, non-interactive wrapper views forwards one control identity.
        var wrapperHost = ifiber.tag === 5 || typeof ifiber.type === 'string';
        var nextForwarded = ich && !ich.sibling && (!wrapperHost || (!itid && !interactive)) ? forwarded : null;
        var parentHostIndex = hostIndex === null ? iframe.parentHostIndex : hostIndex;
        var textOwnerHostIndex = iframe.textOwnerHostIndex;
        if (typographyRecord && hostIndex !== null) {
          if (typographyRecord.hostType === 'RCTText') textOwnerHostIndex = hostIndex;
          else if (typographyRecord.hostType !== 'RCTVirtualText') textOwnerHostIndex = null;
        }
        var childOrderBase = hostEvidence ? (hostIndex === null ? iframe.orderPath : []) : null;
        var childOrdinal = 0;
        while (ich) {
          if (typography && (++iEnqueued > iBudget || Date.now() >= typography.deadline)) { iEnqueueTruncated = true; break; }
          iQueue.push({ fiber: ich, forwarded: nextForwarded, wrapperCandidate: wrapperCandidate, inputAncestors: inputAncestors, parentFiber: ifiber, parentHostIndex: parentHostIndex, textOwnerHostIndex: textOwnerHostIndex, rootIndex: iframe.rootIndex, animatedTypography: typographyRecord && typographyRecord.animated, hidden: hidden, orderPath: childOrderBase ? childOrderBase.concat([childOrdinal++]) : null });
          ich = ich.sibling;
        }
      }
      // Signal truncation rather than silently dropping actionable nodes (a hit
      // cap leaves the queue non-empty). Mirrors the filter branch's truncated
      // flag — a clean-looking partial list would mislead the agent into
      // "nothing more to tap here."
      var iOut = { interactive: salient, totalNodes: iScanned, rootsSeeded: iRoots.length };
      if (iQueue.length > 0 || iEnqueueTruncated) {
        iOut.truncated = true;
        iOut.hint = 'More interactive elements exist beyond the cap — scope with filter or device_scrollintoview.';
      }
      iOut.verdict = buildVerdict('interactive', {
        rootsSeeded: iRoots.length,
        scannedNodes: iScanned,
        scanBudgetExhausted: iQueue.length > 0 || iEnqueueTruncated
      });
      if (hostEvidence) {
        var orderGroups = new Map();
        for (var oi = 0; oi < hostEvidence.hosts.length; oi++) {
          var orderGroup = orderGroups.get(hostOrderParents[oi]);
          if (!orderGroup) orderGroups.set(hostOrderParents[oi], orderGroup = []);
          orderGroup.push(oi);
        }
        orderGroups.forEach(function(group) {
          group.sort(function(a, b) {
            var pa = hostOrderPaths[a], pb = hostOrderPaths[b];
            for (var k = 0; k < pa.length && k < pb.length; k++) if (pa[k] !== pb[k]) return pa[k] - pb[k];
            return pa.length - pb.length;
          });
          for (var rank = 0; rank < group.length; rank++) {
            if (hostTouchKnown[group[rank]]) hostEvidence.hosts[group[rank]].order = rank;
          }
        });
        hostEvidence.complete = hostEvidence.complete && iRoots.length > 0 && iOut.verdict.complete;
        iOut.hostEvidence = hostEvidence;
      }
      return typography ? typography.finish(iOut, iRoots, iBudget, iQueue.length, iPruned) : evidenceJson(iOut);
    }

    // For filtered queries: BFS to find matches, then build compact subtrees.
    // B143: seed the BFS queue from EVERY renderer's root — not just the
    // first one findActiveRenderer picked. Apps with multiple React
    // renderers (LogBox + main Fabric, or main + Reanimated worklet) have
    // their user components spread across renderer IDs; walking only the
    // first found renderer misses the bulk of testIDs.
    if (filter) {
      var f = String(filter).toLowerCase();
      var matchFibers = [];
      var matchFiberSet = new WeakSet();
      var allRoots = findAllRootFibers();
      // Codex review (conf 82): scale the scan budget with the number of
      // seeded roots so later renderers aren't starved by earlier (typically
      // LogBox) ones. Hard cap at 5000 to stay under the 3s wall-clock
      // budget on Hermes.
      var scanBudget = Math.min(5000, 2000 * Math.max(1, allRoots.length));
      var queue = [];
      for (var qi = 0; qi < allRoots.length; qi++) queue.push(allRoots[qi].fiber);
      var seen = new WeakSet();
      var scanned = 0;
      var bfsStart = Date.now();
      function hasMatchedAncestor(f2) {
        var cur = f2.return;
        while (cur) {
          if (matchFiberSet.has(cur)) return true;
          cur = cur.return;
        }
        return false;
      }
      while (queue.length > 0 && scanned < scanBudget && (Date.now() - bfsStart) < 3000) {
        var fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        scanned++;
        var fname = getName(fiber);
        var ftid = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.nativeID);
        var flabel = fiber.memoizedProps && fiber.memoizedProps.accessibilityLabel;
        var matchesName = fname && fname.toLowerCase().indexOf(f) >= 0;
        var matchesTestID = ftid && String(ftid).toLowerCase().indexOf(f) >= 0;
        var matchesLabel = flabel && String(flabel).toLowerCase().indexOf(f) >= 0;
        if ((matchesName || matchesTestID || matchesLabel) && !hasMatchedAncestor(fiber)) {
          matchFibers.push(fiber);
          matchFiberSet.add(fiber);
        }
        var ch = fiber.child;
        while (ch) {
          queue.push(ch);
          ch = ch.sibling;
        }
      }

      // Codex review (conf 80): field renamed from renderersScanned to
      // rootsSeeded to match actual semantic (roots pushed into the BFS
      // queue, not renderers walked 1..5).
      // A no-match verdict distinguishes "scanned everything, truly absent"
      // from "budget ran out mid-scan" — the sparse-vs-empty ambiguity #409
      // exists to kill.
      var filterBudgetHit = queue.length > 0;
      if (matchFibers.length === 0) {
        return JSON.stringify({
          tree: null,
          totalNodes: scanned,
          rootsSeeded: allRoots.length,
          verdict: buildVerdict('filter', {
            rootsSeeded: allRoots.length,
            scannedNodes: scanned,
            scanBudgetExhausted: filterBudgetHit
          })
        });
      }

      var matches = [];
      for (var mi = 0; mi < matchFibers.length && mi < 10; mi++) {
        var subtreeVis = new WeakSet();
        var subtree = walkSubtree(matchFibers[mi], 0, maxDepth, subtreeVis);
        if (subtree) matches.push(subtree);
      }
      totalNodes = scanned;
      var filterVerdictOpts = {
        rootsSeeded: allRoots.length,
        scannedNodes: scanned,
        scanBudgetExhausted: filterBudgetHit
      };
      var tree = matches.length === 1 ? matches[0] : { matches: matches };
      var output = safeStringify({ tree: tree, totalNodes: totalNodes, rootsSeeded: allRoots.length, verdict: buildVerdict('filter', filterVerdictOpts) }, 999999);
      if (output.length > 50000) {
        filterVerdictOpts.outputTruncated = true;
        return safeStringify({ tree: matches[0] || null, totalNodes: totalNodes, rootsSeeded: allRoots.length, truncated: true, verdict: buildVerdict('filter', filterVerdictOpts) });
      }
      return output;
    }

    // Unfiltered: walk EVERY renderer's root, not just the first renderer's
    // first root. findActiveRenderer() typically returns the LogBox shell on
    // Bridgeless + Reanimated apps, so the prior single-root walk returned the
    // shell instead of the app tree. Mirror the filtered branch's
    // findAllRootFibers() seeding (B143/B145); empty roots (e.g. LogBox) walk to
    // null and drop out, so the usual result is just the app tree.
    var allRootsU = findAllRootFibers();
    var trees = [];
    for (var ri = 0; ri < allRootsU.length; ri++) {
      var sub = walkSubtree(allRootsU[ri].fiber, 0, maxDepth, visited);
      if (sub) trees.push(sub);
    }
    var fullVerdictOpts = { rootsSeeded: allRootsU.length, scannedNodes: totalNodes };
    var tree = trees.length === 1 ? trees[0] : (trees.length === 0 ? null : { _wrapper: true, children: trees });
    var output = safeStringify({ tree: tree, totalNodes: totalNodes, rootsSeeded: allRootsU.length, verdict: buildVerdict('full', fullVerdictOpts) }, 999999);
    if (output.length > 50000) {
      fullVerdictOpts.failed = true;
      fullVerdictOpts.outputTruncated = true;
      return safeStringify({ error: 'Tree too large (' + output.length + ' chars). Use a filter parameter to scope the query.', verdict: buildVerdict('full', fullVerdictOpts) });
    }
    return output;
  }

  // Known host kinds use platform view names, not composite component names.
  var HOST_KIND_NAMES = {
    text: ['Text', 'RCTText'],
    textinput: ${JSON.stringify(INPUT_HOST_TYPES)},
    image: ['Image', 'RCTImageView', 'RCTImage'],
    switch: ['Switch', 'RCTSwitch'],
    scrollview: ['ScrollView', 'RCTScrollView'],
    modal: ['Modal', 'RCTModalHostView']
  };
  var HOST_KIND_LOOKUP = (function() {
    var map = {};
    var kinds = Object.keys(HOST_KIND_NAMES);
    for (var ki = 0; ki < kinds.length; ki++) {
      var names = HOST_KIND_NAMES[kinds[ki]];
      for (var ni = 0; ni < names.length; ni++) map[names[ni]] = kinds[ki];
    }
    return map;
  })();

  function isHostFiber(fiber) {
    return !!fiber && (fiber.tag === 5 || typeof fiber.type === 'string');
  }

  function hostKind(fiber) {
    if (!fiber || !fiber.type) return null;
    if (fiber.tag === 6) return null;
    var name = typeof fiber.type === 'string'
      ? fiber.type
      : (fiber.type.displayName || fiber.type.name || null);
    if (!name) return null;
    var kind = HOST_KIND_LOOKUP[name];
    return kind || null;
  }

  // Navigation State
  function getNavState() {
    try {
      var state = globalThis.__expo_router_state__;
      if (state) return safeStringify(state, 50000);
    } catch(e) {}

    try {
      var devtools = globalThis.__REACT_NAVIGATION_DEVTOOLS__;
      if (devtools && devtools.getNavState) return safeStringify(devtools.getNavState(), 50000);
    } catch(e) {}

    function isNavLike(obj) {
      return obj && Array.isArray(obj.routes) && typeof obj.index === 'number';
    }

    function findNavInHooks(memoizedState) {
      var hook = memoizedState;
      var depth = 0;
      while (hook && depth < 30) {
        if (hook.memoizedState && isNavLike(hook.memoizedState)) return hook.memoizedState;
        if (isNavLike(hook)) return hook;
        if (hook.queue && hook.queue.lastRenderedState && isNavLike(hook.queue.lastRenderedState)) return hook.queue.lastRenderedState;
        hook = hook.next;
        depth++;
      }
      return null;
    }

    function findNav(fiber, depth) {
      var current = fiber;
      while (current) {
        if ((depth || 0) > 30) return null;
        var name = current.type && (current.type.displayName || current.type.name);
        if (name === 'NavigationContainer' || name === 'ExpoRoot') {
          var found = findNavInHooks(current.memoizedState);
          if (found) return found;
        }
        var found = findNav(current.child, (depth || 0) + 1);
        if (found) return found;
        current = current.sibling;
      }
      return null;
    }

    // B145: walk every renderer's root — NavigationContainer may live on
    // the main Fabric renderer while LogBox shell occupies renderer 1.
    var navState = forEachRootFiber(function(rootFiber) {
      return findNav(rootFiber);
    });

    if (!navState) {
      var fallbackRef = findNavRef();
      if (fallbackRef && fallbackRef.getRootState) navState = fallbackRef.getRootState();
    }

    // GH #525 — mid-mount evidence (empty roots, bundled framework, a
    // shell-only tree) must not be misreported as a missing router install.
    if (!navState) {
      var mountHook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      var mountHookUsable = !!(mountHook && typeof mountHook.getFiberRoots === 'function');
      var mountRoots = mountHookUsable ? findAllRootFibers() : [];
      // Only a complete, clean scan is mounting evidence.
      var mountCoverage = rootScanCoverage();
      var mountScanClean = mountHookUsable && mountCoverage.reasons.length === 0;
      if (mountScanClean && mountRoots.length === 0) {
        return JSON.stringify({
          error: 'App is still mounting — no React fiber roots exist yet (the bundle is likely still loading). Retry in ~2s.',
          mounting: true,
          retryInMs: 2000
        });
      }
      if (mountHookUsable && mountCoverage.reasons.indexOf('root-enumeration-incomplete') !== -1 && mountRoots.length === 0) {
        return JSON.stringify({ error: 'Navigation state not found. Is React Navigation or Expo Router installed?' });
      }
      var navFw = navDetectBundledFramework();
      if (navFw) {
        var navFwName = navFw === 'expo-router' ? 'Expo Router' : 'React Navigation';
        return JSON.stringify({
          error: navFwName + ' is bundled but no navigation state was found — the app may still be mounting after a reload (retry in ~2s), or no navigation container is rendered.',
          frameworkDetected: navFw,
          retryInMs: 2000
        });
      }
      // Current-state render evidence, not a timer: no committed root holds any
      // app component yet — only the dev shell is rendered.
      if (mountScanClean && mountRoots.length > 0 && navAllRootsWithoutAppContent(mountRoots)) {
        return JSON.stringify({
          error: 'App UI is still mounting — no app components have rendered yet, only the development shell. Retry in ~2s. If this persists, React Navigation or Expo Router may be missing.',
          mounting: true,
          shellOnly: true,
          retryInMs: 2000
        });
      }
      return JSON.stringify({ error: 'Navigation state not found. Is React Navigation or Expo Router installed?' });
    }

    function simplify(s) {
      if (!s) return null;
      var r = {
        routeName: s.routes && s.routes[s.index] && s.routes[s.index].name,
        params: (s.routes && s.routes[s.index] && s.routes[s.index].params) || {},
        stack: (s.routes && s.routes.map(function(r) { return r.name; })) || [],
        index: s.index
      };
      var activeRoute = s.routes && s.routes[s.index];
      if (activeRoute && activeRoute.state) {
        r.nested = simplify(activeRoute.state);
      }
      return r;
    }

    return JSON.stringify(simplify(navState));
  }

  // Navigation Graph — full topology extraction
  function getNavGraph() {
    try {
      var navigators = [];
      var navIdCounter = 0;
      var containersFound = 0;
      var library = 'unknown';
      var rnVersion = null;
      var expoSdk = null;

      try {
        var RN = require('react-native');
        try { var rnV = require('react-native/Libraries/Core/ReactNativeVersion').version; rnVersion = rnV.major + '.' + rnV.minor + '.' + rnV.patch; } catch(e) {}
      } catch(e) {}
      try { var expoC = require('expo-constants'); if (expoC && expoC.default && expoC.default.expoConfig) expoSdk = expoC.default.expoConfig.sdkVersion || null; } catch(e) {}

      // Detect navigator kind from state.type + fiber heuristic
      function detectKind(stateType, fiberHint) {
        if (stateType === 'tab') return 'tab';
        if (stateType === 'drawer') return 'drawer';
        if (stateType === 'stack') {
          if (fiberHint && (fiberHint.indexOf('NativeStack') !== -1 || fiberHint.indexOf('native-stack') !== -1)) return 'native-stack';
          return 'stack';
        }
        return 'unknown';
      }

      // Build navigator ID
      function makeNavId(parentScreen, kind) {
        if (!parentScreen) return 'root' + (navIdCounter > 0 ? '-' + navIdCounter : '');
        return parentScreen + '/' + kind;
      }

      // Duck-type navigation state: must have routes array + routeNames array
      function isNavState(obj) {
        return obj && Array.isArray(obj.routes) && Array.isArray(obj.routeNames);
      }

      // Walk memoizedState linked list to find navigation state
      function findNavStateInHooks(memoizedState) {
        var current = memoizedState;
        var depth = 0;
        while (current && depth < 30) {
          if (current.memoizedState && isNavState(current.memoizedState)) return current.memoizedState;
          if (isNavState(current)) return current;
          // Check queue (useReducer stores state in .queue.lastRenderedState or .memoizedState)
          if (current.queue && current.queue.lastRenderedState && isNavState(current.queue.lastRenderedState)) return current.queue.lastRenderedState;
          current = current.next;
          depth++;
        }
        return null;
      }

      // Flatten linking config: { screens: { Name: 'path' | { path, screens } } }
      function flattenLinking(config, prefix) {
        var map = {};
        if (!config || !config.screens) return map;
        var screens = config.screens;
        var keys = Object.keys(screens);
        for (var i = 0; i < keys.length; i++) {
          var name = keys[i];
          var val = screens[name];
          if (typeof val === 'string') {
            map[name] = (prefix ? prefix + '/' : '') + val;
          } else if (val && typeof val === 'object') {
            var path = val.path !== undefined ? val.path : name;
            var fullPath = (prefix ? prefix + '/' : '') + path;
            map[name] = fullPath;
            if (val.screens) {
              var nested = flattenLinking({ screens: val.screens }, fullPath);
              var nk = Object.keys(nested);
              for (var j = 0; j < nk.length; j++) map[nk[j]] = nested[nk[j]];
            }
          }
        }
        return map;
      }

      // Extract params from path pattern like "/cart/:id/review/:reviewId"
      function extractParams(path) {
        if (!path) return null;
        var matches = path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
        if (!matches || matches.length === 0) return null;
        return matches.map(function(m) { return m.slice(1); });
      }

      // Recursively walk navigation state, collecting navigators (read-only — no mutation)
      function walkState(state, parentScreen, linkingMap, fiberHint, depth) {
        if (!state || depth > 20) return;

        var kind = detectKind(state.type, fiberHint);
        var navId = makeNavId(parentScreen, kind);
        var seenIds = {};
        for (var si = 0; si < navigators.length; si++) {
          seenIds[navigators[si].id] = true;
        }
        if (seenIds[navId]) navId = navId + '-' + (++navIdCounter);

        var screenNames = state.routeNames || [];
        var routes = [];
        var activeIndex = typeof state.index === 'number' ? state.index : 0;
        var activeRouteName = state.routes && state.routes[activeIndex] ? state.routes[activeIndex].name : null;

        for (var i = 0; i < screenNames.length; i++) {
          var name = screenNames[i];
          var matchedRoute = null;
          if (state.routes) {
            for (var j = 0; j < state.routes.length; j++) {
              if (state.routes[j].name === name) { matchedRoute = state.routes[j]; break; }
            }
          }
          var isVisited = !!matchedRoute;
          var linkPath = linkingMap ? (linkingMap[name] !== undefined ? linkingMap[name] : null) : null;
          var params = extractParams(linkPath);

          routes.push({
            name: name,
            path: linkPath !== null ? linkPath : undefined,
            params_schema: params || undefined,
            is_initial: name === activeRouteName && activeIndex === 0,
            is_active: name === activeRouteName,
            is_visited: isVisited
          });
        }

        navigators.push({
          id: navId,
          kind: kind,
          parent_screen: parentScreen || null,
          routes: routes,
          active_route_name: activeRouteName,
          initial_route_name: screenNames[0] || undefined,
          is_visited: true,
          source: linkingMap && Object.keys(linkingMap).length > 0 ? 'both' : 'runtime'
        });

        // Recurse into all routes that have nested state
        if (state.routes) {
          for (var ri = 0; ri < state.routes.length; ri++) {
            var route = state.routes[ri];
            if (route.state && isNavState(route.state)) {
              walkState(route.state, route.name, linkingMap, null, depth + 1);
            }
          }
        }
      }

      // -- Primary path: __NAV_REF__.getRootState() --
      var rootState = null;
      var linkingMap = {};

      if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getRootState) {
        var refState = globalThis.__NAV_REF__.getRootState();
        if (isNavState(refState)) {
          rootState = refState;
          containersFound = 1;
          library = 'react-navigation';
        }
      }

      // -- Expo Router fast path --
      if (!rootState && globalThis.__expo_router_state__) {
        try {
          var expoState = globalThis.__expo_router_state__;
          if (isNavState(expoState)) {
            rootState = expoState;
            containersFound = 1;
            library = 'expo-router';
          }
        } catch(e) {}
      }

      // -- Fallback: fiber walk --
      if (!rootState) {
        // B145: collect NavigationContainer/ExpoRoot fibers across every
        // renderer. Containers can live on any renderer — main Fabric
        // usually, but an Expo Dev Client + Reanimated app may register
        // more than one. Previously this only scanned renderer 1.
        var containerFibers = [];
        var allRoots = findAllRootFibers();
        for (var ar = 0; ar < allRoots.length; ar++) {
          (function findContainers(fiber, d) {
            if (!fiber || d > 30) return;
            var ft = fiber.type;
            var fname = ft && (ft.displayName || ft.name);
            if (!fname && ft && ft.render) fname = ft.render.displayName || ft.render.name;
            if (fname === 'NavigationContainer' || fname === 'ExpoRoot') {
              containerFibers.push(fiber);
            }
            findContainers(fiber.child, d + 1);
            if (fiber.sibling) findContainers(fiber.sibling, d);
          })(allRoots[ar].fiber, 0);
        }

        containersFound = containerFibers.length;
        for (var ci = 0; ci < containerFibers.length; ci++) {
          var cf = containerFibers[ci];
          var fiberState = findNavStateInHooks(cf.memoizedState);
          if (!fiberState && globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getRootState) {
            fiberState = globalThis.__NAV_REF__.getRootState();
          }
          if (fiberState && isNavState(fiberState)) {
            if (!rootState) rootState = fiberState;
            // Harvest linking config from fiber props
            try {
              var linking = cf.memoizedProps && cf.memoizedProps.linking;
              if (!linking && cf.return) linking = cf.return.memoizedProps && cf.return.memoizedProps.linking;
              if (linking && linking.config) {
                linkingMap = flattenLinking(linking.config, '');
              }
            } catch(e) {}
            var cft = cf.type;
            var fName = cft && (cft.displayName || cft.name);
            if (!fName && cft && cft.render) fName = cft.render.displayName || cft.render.name;
            if (fName === 'ExpoRoot') library = 'expo-router';
            else library = 'react-navigation';
          }
        }
      }

      // GH #597: React Navigation 7 renders the container through a forwardRef
      // whose inner name (NavigationContainerInner) is outside the accepted
      // container-name set — reuse the proven nav-ref discovery walk.
      if (!rootState) {
        try {
          var graphRef = findNavRef();
          if (graphRef && graphRef.getRootState) {
            var graphState = graphRef.getRootState();
            if (isNavState(graphState)) {
              rootState = graphState;
              library = 'react-navigation';
              if (!containersFound) containersFound = 1;
              try {
                if (graphRef.getLinkingOptions) {
                  var graphLinking = graphRef.getLinkingOptions();
                  if (graphLinking && graphLinking.config) linkingMap = flattenLinking(graphLinking.config, '');
                }
              } catch(e) {}
            }
          }
        } catch(e) {}
      }

      // Also try to harvest linking config from __NAV_REF__ if fiber didn't get it
      if (Object.keys(linkingMap).length === 0) {
        try {
          if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getLinkingOptions) {
            var lo = globalThis.__NAV_REF__.getLinkingOptions();
            if (lo && lo.config) linkingMap = flattenLinking(lo.config, '');
          }
        } catch(e) {}
        // Expo Router auto-linking
        try {
          if (Object.keys(linkingMap).length === 0 && globalThis.__expo_router_linking__) {
            var erl = globalThis.__expo_router_linking__;
            if (erl.config) linkingMap = flattenLinking(erl.config, '');
          }
        } catch(e) {}
      }

      if (!rootState) return JSON.stringify({ error: 'No navigation state found. Is React Navigation or Expo Router installed?' });

      // Walk the state tree
      walkState(rootState, null, linkingMap, null, 0);

      return safeStringify({
        library: library,
        rn_version: rnVersion,
        expo_sdk: expoSdk,
        navigators: navigators,
        containers_found: containersFound
      }, 200000);

    } catch(e) {
      return JSON.stringify({ error: 'Nav graph extraction failed: ' + (e && e.message || String(e)) });
    }
  }

  // Store State
  function getStoreState(path, requestedType) {
    var state = null;
    var storeType = null;

    if (!requestedType || requestedType === 'redux') {
      var fiberStore = findProviderStore(function(name, props) {
        return name === 'Provider' && props && props.store && props.store.getState
          ? props.store
          : null;
      });
      if (fiberStore) {
        state = fiberStore.getState();
        storeType = 'redux';
      }
      if (!state && globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.getState) {
        state = globalThis.__REDUX_STORE__.getState();
        storeType = 'redux';
      }
    }
    if (!state && (!requestedType || requestedType === 'zustand')) {
      if (globalThis.__ZUSTAND_STORES__) {
        var result = {};
        var keys = Object.keys(globalThis.__ZUSTAND_STORES__);
        for (var i = 0; i < keys.length; i++) {
          var name = keys[i];
          var store = globalThis.__ZUSTAND_STORES__[name];
          result[name] = typeof store.getState === 'function' ? store.getState() : store;
        }
        state = result;
        storeType = 'zustand';
      }
    }
    if (!state && (!requestedType || requestedType === 'jotai')) {
      if (globalThis.__JOTAI_STORE__ && globalThis.__JOTAI_ATOMS__) {
        var jStore = globalThis.__JOTAI_STORE__;
        var jAtoms = globalThis.__JOTAI_ATOMS__;
        if (typeof jStore.get === 'function') {
          var result = {};
          var keys = Object.keys(jAtoms);
          for (var i = 0; i < keys.length; i++) {
            try { result[keys[i]] = jStore.get(jAtoms[keys[i]]); } catch(e) { result[keys[i]] = '<<error: ' + (e && e.message || String(e)) + '>>'; }
          }
          state = result;
          storeType = 'jotai';
        }
      }
    }

    if (!state) {
      var found = findProviderStore(function(name, props) {
        if (name === 'Provider' && props && props.store && props.store.getState) {
          return { store: props.store.getState(), type: 'redux' };
        }
        if (name === 'QueryClientProvider' && props && props.client && typeof props.client.getQueryCache === 'function') {
          try {
            var queries = props.client.getQueryCache().getAll();
            var mapped = {};
            for (var q = 0; q < queries.length; q++) {
              var key = JSON.stringify(queries[q].queryKey);
              mapped[key] = { data: queries[q].state.data, status: queries[q].state.status, dataUpdatedAt: queries[q].state.dataUpdatedAt };
            }
            return { store: mapped, type: 'react-query' };
          } catch(e) {}
        }
        return null;
      });
      if (found) { state = found.store; storeType = found.type; }
    }

    if (!state) {
      return JSON.stringify({
        __agent_error: 'No store found.',
        hint: 'For Zustand, add to app entry: if (__DEV__) global.__ZUSTAND_STORES__ = { myStore }',
        hint2: 'For Redux, the Provider is auto-detected from the fiber tree. If it still is not found, expose it: if (__DEV__) global.__REDUX_STORE__ = store',
        hint3: 'For Jotai, add: if (__DEV__) { global.__JOTAI_STORE__ = store; global.__JOTAI_ATOMS__ = { count: countAtom } }'
      });
    }

    if (path) {
      var parts = path.split('.');
      var current = state;
      for (var i = 0; i < parts.length; i++) {
        var next = current && current[parts[i]];
        if (next === undefined && i === 0 && storeType === 'zustand') {
          var storeKeys = Object.keys(current);
          var lower = parts[0].toLowerCase().replace(/^use|store$/gi, '');
          for (var k = 0; k < storeKeys.length; k++) {
            var sk = storeKeys[k].toLowerCase().replace(/^use|store$/gi, '');
            if (sk === lower) { next = current[storeKeys[k]]; parts[0] = storeKeys[k]; break; }
          }
        }
        current = next;
        if (current === undefined) {
          return JSON.stringify({ __agent_error: 'Path not found: ' + path, availableKeys: Object.keys(state) });
        }
      }
      state = current;
    }

    return safeStringify({ type: storeType, state: state }, 30000);
  }

  // Console Capture — monkey-patch console to capture app-level logs
  // CDP Runtime.consoleAPICalled doesn't fire for RN Bridgeless app-level console calls
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

  function getConsole(opts) {
    opts = opts || {};
    var level = opts.level || 'all';
    var lim = opts.limit || 50;
    var entries = [];
    for (var i = 0; i < consoleBuf.length; i++) {
      if (level === 'all' || consoleBuf[i].level === level) {
        entries.push(consoleBuf[i]);
      }
    }
    return JSON.stringify(entries.slice(-lim));
  }

  function clearConsole() {
    consoleBuf.length = 0;
    return 'cleared';
  }

  // Error Tracking — use global array so reinjection doesn't lose buffered errors
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
        stack: error && error.stack && error.stack.split('\\n').slice(0, 8).join('\\n'),
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

  function getErrors() { return JSON.stringify(errors); }
  function clearErrors() { errors.length = 0; return 'cleared'; }

  // ponytail: one budget for read-back and mutation; a pre-read that resolves must not be followed by a mutation that truncates
  var TYPE_TEXT_WORK_LIMIT = 500000;

  function createTypeTextState(workLimit) {
    return {
      work: 0,
      workLimit: workLimit || TYPE_TEXT_WORK_LIMIT,
      visitedFibers: 0,
      truncated: false,
      reason: null
    };
  }

  function consumeTypeTextWork(state) {
    if (state.work >= state.workLimit) {
      state.truncated = true;
      state.reason = 'work-limit';
      return false;
    }
    state.work++;
    return true;
  }

  function sameTypeTextFiber(a, b) {
    return !!a && !!b && (a === b || a.alternate === b || b.alternate === a);
  }

  function typeTextFiberName(fiber) {
    return (fiber && fiber.type && (typeof fiber.type === 'string'
      ? fiber.type
      : (fiber.type.displayName || fiber.type.name))) || 'Unknown';
  }

  function typeTextTruncation(state) {
    return {
      error: 'typeText resolution truncated',
      truncated: true,
      reason: state.reason,
      scanned: state.visitedFibers,
      work: state.work,
      workLimit: state.workLimit,
      handlerCalled: false,
      hint: 'The bounded typeText resolver did not inspect the complete selector and candidate graph; no handler was called.'
    };
  }

  function resolveTypeTextTarget(opts, workLimit) {
    var state = createTypeTextState(workLimit);

    function consumeWork() {
      return consumeTypeTextWork(state);
    }

    var TYPE_TEXT_ABORT = {};

    function forEachTypeTextRoot(callback) {
      if (!consumeWork()) return TYPE_TEXT_ABORT;
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook && typeof hook.getFiberRoots === 'function') {
        var rendererIds = [];
        var rendererIdSeen = Object.create(null);
        var usingRegisteredIds = false;
        try {
          if (hook.renderers && typeof hook.renderers.keys === 'function') {
            if (!consumeWork()) return TYPE_TEXT_ABORT;
            var rendererIterator = hook.renderers.keys();
            var rendererStep;
            while (rendererIterator && typeof rendererIterator.next === 'function') {
              if (!consumeWork()) return TYPE_TEXT_ABORT;
              rendererStep = rendererIterator.next();
              if (rendererStep.done) break;
              if (!consumeWork()) return TYPE_TEXT_ABORT;
              var registeredId = rendererStep.value;
              var registeredKey = typeof registeredId + ':' + String(registeredId);
              if (typeof registeredId === 'number' && !rendererIdSeen[registeredKey]) {
                rendererIdSeen[registeredKey] = true;
                rendererIds.push(registeredId);
                usingRegisteredIds = true;
              }
            }
          }
        } catch (_) {}
        for (var fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
          if (!consumeWork()) return TYPE_TEXT_ABORT;
          var fallbackKey = 'number:' + String(fallbackId);
          if (!rendererIdSeen[fallbackKey]) {
            rendererIdSeen[fallbackKey] = true;
            rendererIds.push(fallbackId);
          }
        }
        var emptyStreak = 0;
        for (var rendererIndex = 0; rendererIndex < rendererIds.length; rendererIndex++) {
          if (!consumeWork()) return TYPE_TEXT_ABORT;
          var rendererId = rendererIds[rendererIndex];
          try {
            if (!consumeWork()) return TYPE_TEXT_ABORT;
            var roots = hook.getFiberRoots(rendererId);
            if (roots && roots.size) {
              emptyStreak = 0;
              if (!consumeWork()) return TYPE_TEXT_ABORT;
              var rootIterator = roots.values();
              while (rootIterator && typeof rootIterator.next === 'function') {
                if (!consumeWork()) return TYPE_TEXT_ABORT;
                var rootStep = rootIterator.next();
                if (rootStep.done) break;
                if (!consumeWork()) return TYPE_TEXT_ABORT;
                var rootFiber = rootStep.value && rootStep.value.current;
                if (rootFiber) {
                  if (!consumeWork()) return TYPE_TEXT_ABORT;
                  var rootResult = callback(rootFiber);
                  if (rootResult) return rootResult;
                  if (state.truncated) return TYPE_TEXT_ABORT;
                }
              }
            } else if (!usingRegisteredIds) {
              emptyStreak++;
              if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && rendererId >= 5) break;
            }
          } catch (_) {}
        }
      }
      if (state.truncated) return TYPE_TEXT_ABORT;
      try {
        if (!consumeWork()) return TYPE_TEXT_ABORT;
        var extraResolver = globalThis.__QAREN_EXTRA_ROOTS__;
        if (typeof extraResolver === 'function') {
          if (!consumeWork()) return TYPE_TEXT_ABORT;
          var instances = extraResolver();
          if (Array.isArray(instances)) {
            for (var instanceIndex = 0; instanceIndex < instances.length; instanceIndex++) {
              if (!consumeWork()) return TYPE_TEXT_ABORT;
              var extraFiber = extractFiberFromInstance(instances[instanceIndex]);
              if (extraFiber) {
                if (!consumeWork()) return TYPE_TEXT_ABORT;
                var extraResult = callback(extraFiber);
                if (extraResult) return extraResult;
                if (state.truncated) return TYPE_TEXT_ABORT;
              }
            }
          }
        }
      } catch (_) {}
      return null;
    }

    var selectorKind = null;
    if (typeof opts.testID === 'string' && opts.testID.length > 0) selectorKind = 'testID';
    else if (typeof opts.accessibilityLabel === 'string' && opts.accessibilityLabel.length > 0) selectorKind = 'accessibilityLabel';
    else if (typeof opts.placeholder === 'string' && opts.placeholder.length > 0) selectorKind = 'placeholder';
    else if (typeof opts.role === 'string' && typeof opts.name === 'string' && opts.name.length > 0) selectorKind = 'role+name';

    if (!selectorKind) {
      return {
        error: 'typeText requires testID, accessibilityLabel, placeholder, or role+name',
        hint: 'The text parameter is the value to enter, not a byText selector.'
      };
    }

    var exactSources = [];
    var normalizedSources = [];
    var containsSources = [];
    var sources = [];
    var selector = opts.testID || opts.accessibilityLabel || opts.placeholder || opts.name;
    var normalizedSelector = selectorKind === 'accessibilityLabel'
      ? String(selector).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').toLowerCase()
      : null;
    var wantedRole = selectorKind === 'role+name' ? normalizeRole(opts.role) : null;
    var sourceIdentitySeen = new WeakSet();
    var candidateIdentitySeen = new WeakSet();
    var candidates = [];

    function isNativeTextInputHost(fiber) {
      return fiber && fiber.tag === 5 && typeof fiber.type === 'string' && hostKind(fiber) === 'textinput';
    }

    function addSource(target, source) {
      if (!consumeWork()) return;
      var fiber = source.fiber;
      if (sourceIdentitySeen.has(fiber) || (fiber.alternate && sourceIdentitySeen.has(fiber.alternate))) return;
      sourceIdentitySeen.add(fiber);
      if (fiber.alternate) sourceIdentitySeen.add(fiber.alternate);
      target.push(source);
    }

    function addCandidate(fiber, inherited) {
      if (!consumeWork()) return;
      if (candidateIdentitySeen.has(fiber) || (fiber.alternate && candidateIdentitySeen.has(fiber.alternate))) return;
      var props = fiber.memoizedProps || {};
      var contract = null;
      var handler = null;
      if (typeof props.onChangeText === 'function') {
        contract = 'onChangeText:string';
        handler = props.onChangeText;
      } else if (typeof props.onChange === 'function' && isNativeTextInputHost(fiber)) {
        contract = 'onChange:event';
        handler = props.onChange;
      }
      if (!contract) return;
      candidateIdentitySeen.add(fiber);
      if (fiber.alternate) candidateIdentitySeen.add(fiber.alternate);
      candidates.push({
        fiber: fiber,
        inherited: inherited,
        alternate: fiber.alternate || null,
        props: props,
        name: typeTextFiberName(fiber),
        contract: contract,
        handler: handler
      });
    }

    function typeTextFindByNativeID(id) {
      var match = null;
      var completed = new WeakSet();
      forEachTypeTextRoot(function(rootFiber) {
        if (match || state.truncated) return match || TYPE_TEXT_ABORT;
        var localSeen = new WeakSet();
        if (!consumeWork()) return TYPE_TEXT_ABORT;
        var stack = [rootFiber];
        while (stack.length > 0 && !state.truncated) {
          var node = stack.pop();
          if (!consumeWork()) break;
          if (!consumeWork()) break;
          if (localSeen.has(node)) {
            state.truncated = true;
            state.reason = 'cycle';
            break;
          }
          localSeen.add(node);
          if (completed.has(node)) continue;
          completed.add(node);
          state.visitedFibers++;
          var props = node.memoizedProps || {};
          if (props.nativeID === id) {
            match = node;
            break;
          }
          if (node.sibling) {
            if (!consumeWork()) break;
            stack.push(node.sibling);
          }
          if (node.child) {
            if (!consumeWork()) break;
            stack.push(node.child);
          }
        }
        return match || (state.truncated ? TYPE_TEXT_ABORT : null);
      });
      return match;
    }

    function typeTextRefTextContent(fiber) {
      var parts = [];
      var seen = new WeakSet();
      if (!consumeWork()) return undefined;
      var stack = [{ fiber: fiber, includeSibling: false }];
      while (stack.length > 0 && !state.truncated) {
        var frame = stack.pop();
        var node = frame.fiber;
        if (!consumeWork()) break;
        if (!consumeWork()) break;
        if (seen.has(node)) {
          state.truncated = true;
          state.reason = 'cycle';
          break;
        }
        seen.add(node);
        if (frame.includeSibling && node.sibling) {
          if (!consumeWork()) break;
          stack.push({ fiber: node.sibling, includeSibling: true });
        }
        if (typeof node.memoizedProps === 'string') {
          if (node.memoizedProps) parts.push(node.memoizedProps);
          continue;
        }
        if (node.child) {
          if (!consumeWork()) break;
          stack.push({ fiber: node.child, includeSibling: true });
        }
      }
      return state.truncated ? undefined : __anNorm(parts.join(' '));
    }

    function typeTextLabelledByIds(fiber) {
      if (!consumeWork()) return [];
      var props = (fiber && fiber.memoizedProps) || {};
      var ariaLabelledBy = props['aria-labelledby'];
      if (typeof ariaLabelledBy === 'string') return [ariaLabelledBy];
      var accessibilityLabelledBy = props.accessibilityLabelledBy;
      if (typeof accessibilityLabelledBy === 'string') return [accessibilityLabelledBy];
      var ids = [];
      if (Array.isArray(accessibilityLabelledBy)) {
        for (var labelledByIndex = 0; labelledByIndex < accessibilityLabelledBy.length; labelledByIndex++) {
          if (!consumeWork()) break;
          ids.push(accessibilityLabelledBy[labelledByIndex]);
        }
      }
      return ids;
    }

    function typeTextAriaLabel(fiber) {
      var ids = typeTextLabelledByIds(fiber);
      if (state.truncated) return undefined;
      if (ids.length > 0) {
        var labelTexts = [];
        for (var idIndex = 0; idIndex < ids.length; idIndex++) {
          if (!consumeWork()) return undefined;
          var ref = typeTextFindByNativeID(ids[idIndex]);
          if (state.truncated) return undefined;
          if (ref) {
            var refText = typeTextRefTextContent(ref);
            if (state.truncated) return undefined;
            if (refText) labelTexts.push(refText);
          }
        }
        if (labelTexts.length > 0) return __anNorm(labelTexts.join(' '));
      }
      var props = (fiber && fiber.memoizedProps) || {};
      var explicit = props['aria-label'];
      if (explicit === undefined || explicit === null) explicit = props.accessibilityLabel;
      if (explicit) return explicit;
      if (hostKind(fiber) === 'image' && props.alt) return props.alt;
      return undefined;
    }

    function typeTextJoinNameParts(parts, inline) {
      var output = '';
      for (var partIndex = 0; partIndex < parts.length; partIndex++) {
        if (!consumeWork()) return undefined;
        if (partIndex === 0) output = parts[partIndex].text;
        else {
          var previous = parts[partIndex - 1];
          var separator = inline && previous.isInlineText && parts[partIndex].isInlineText ? '' : ' ';
          output = output + separator + parts[partIndex].text;
        }
      }
      return output;
    }

    function typeTextAccessibleName(fiber) {
      var seen = new WeakSet();
      if (!consumeWork()) return undefined;
      var stack = [{ fiber: fiber, root: true, entered: false, child: null, parts: [], result: undefined }];
      while (stack.length > 0 && !state.truncated) {
        var frame = stack[stack.length - 1];
        if (!frame.entered) {
          if (!consumeWork()) break;
          if (!consumeWork()) break;
          if (seen.has(frame.fiber)) {
            state.truncated = true;
            state.reason = 'cycle';
            break;
          }
          seen.add(frame.fiber);
          frame.entered = true;
          if (typeof frame.fiber.memoizedProps === 'string') {
            frame.result = frame.fiber.memoizedProps || undefined;
          } else {
            var label = typeTextAriaLabel(frame.fiber);
            if (state.truncated) break;
            if (label) {
              frame.result = label;
            } else {
              var props = frame.fiber.memoizedProps || {};
              if (frame.root && hostKind(frame.fiber) === 'textinput' && props.placeholder) {
                frame.result = props.placeholder;
              } else {
                frame.child = frame.fiber.child;
              }
            }
          }
        } else if (frame.result === undefined && frame.child) {
          if (!consumeWork()) break;
          var child = frame.child;
          frame.child = child.sibling;
          stack.push({ fiber: child, root: false, entered: false, child: null, parts: [], result: undefined });
        } else {
          if (frame.result === undefined) {
            var joined = typeTextJoinNameParts(frame.parts, hostKind(frame.fiber) === 'text');
            if (state.truncated) break;
            frame.result = joined || undefined;
          }
          if (!consumeWork()) break;
          stack.pop();
          if (stack.length === 0) return frame.result;
          if (frame.result) {
            if (!consumeWork()) break;
            stack[stack.length - 1].parts.push({
              text: frame.result,
              isInlineText: typeof frame.fiber.memoizedProps === 'string'
                || hostKind(frame.fiber) === 'text'
            });
          }
        }
      }
      return undefined;
    }

    function typeTextStyleIsHidden(style) {
      if (style == null) return false;
      var display = null;
      var active = new WeakSet();
      if (!consumeWork()) return false;
      var stack = [{ value: style, exit: false }];
      while (stack.length > 0 && !state.truncated) {
        if (!consumeWork()) break;
        var frame = stack.pop();
        var part = frame.value;
        if (frame.exit) {
          active.delete(part);
          continue;
        }
        if (!part || typeof part !== 'object') continue;
        if (!consumeWork()) break;
        if (active.has(part)) {
          state.truncated = true;
          state.reason = 'cycle';
          break;
        }
        active.add(part);
        if (!consumeWork()) break;
        stack.push({ value: part, exit: true });
        if (Array.isArray(part)) {
          for (var styleIndex = part.length - 1; styleIndex >= 0; styleIndex--) {
            if (!consumeWork()) break;
            stack.push({ value: part[styleIndex], exit: false });
          }
        } else if (Object.prototype.hasOwnProperty.call(part, 'display')) {
          display = part.display;
        }
      }
      return !state.truncated && display === 'none';
    }

    function typeTextSubtreeIsHidden(fiber) {
      var props = (fiber && fiber.memoizedProps) || {};
      if (props['aria-hidden']) return true;
      if (props.accessibilityElementsHidden) return true;
      if (props.importantForAccessibility === 'no-hide-descendants') return true;
      if (typeTextStyleIsHidden(props.style)) return true;
      if (state.truncated) return false;
      var parent = fiber && fiber.return;
      if (!parent || !parent.child) return false;
      var seen = new WeakSet();
      var sibling = parent.child;
      while (sibling && !state.truncated) {
        if (!consumeWork()) break;
        if (!consumeWork()) break;
        if (seen.has(sibling)) {
          state.truncated = true;
          state.reason = 'cycle';
          break;
        }
        seen.add(sibling);
        if (sibling !== fiber) {
          var siblingProps = sibling.memoizedProps || {};
          if (siblingProps['aria-modal'] || siblingProps.accessibilityViewIsModal) return true;
        }
        if (!consumeWork()) break;
        sibling = sibling.sibling;
      }
      return false;
    }

    function typeTextIsHidden(fiber) {
      var seen = new WeakSet();
      var current = fiber;
      while (current && !state.truncated) {
        if (!consumeWork()) break;
        if (!consumeWork()) break;
        if (seen.has(current)) {
          state.truncated = true;
          state.reason = 'cycle';
          break;
        }
        seen.add(current);
        if (typeTextSubtreeIsHidden(current)) return true;
        if (!consumeWork()) break;
        current = current.return;
      }
      return false;
    }

    function addVisibleSource(source) {
      if (opts.includeHidden === true) {
        addSource(sources, source);
        return;
      }
      var hidden = typeTextIsHidden(source.fiber);
      if (!state.truncated && !hidden) addSource(sources, source);
    }

    function collectSource(fiber, inherited) {
      if (!consumeWork()) return;
      var props = fiber.memoizedProps || {};
      if (selectorKind === 'testID') {
        if (props.testID === opts.testID || props.nativeID === opts.testID) {
          addSource(sources, {
            fiber: fiber,
            inherited: inherited,
            evidence: { testID: props.testID, nativeID: props.nativeID, selectorBundle: null }
          });
        }
        return;
      }
      if (selectorKind === 'accessibilityLabel') {
        var raw = props.accessibilityLabel;
        if (raw === undefined || raw === null || raw === '') return;
        if (raw === opts.accessibilityLabel) {
          addSource(exactSources, {
            fiber: fiber,
            evidence: { testID: props.testID, accessibilityLabel: raw, selectorBundle: null }
          });
          return;
        }
        var normalized = String(raw).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').toLowerCase();
        var labelSource = {
          fiber: fiber,
          evidence: { testID: props.testID, accessibilityLabel: raw, selectorBundle: null }
        };
        if (normalized === normalizedSelector) addSource(normalizedSources, labelSource);
        else if (normalized.indexOf(normalizedSelector) >= 0) addSource(containsSources, labelSource);
        return;
      }
      if (selectorKind === 'placeholder') {
        if (hostKind(fiber) !== 'textinput') return;
        var placeholder = props && typeof props.placeholder === 'string' ? props.placeholder : null;
        if (placeholder !== null && __match(placeholder, { value: opts.placeholder, exact: opts.exact === true })) {
          addVisibleSource({
            fiber: fiber,
            evidence: {
              testID: props.testID,
              placeholder: placeholder,
              selectorBundle: {
                testID: props.testID,
                role: __role(fiber),
                placeholder: placeholder
              }
            }
          });
        }
        return;
      }
      if (!__isA11yElement(fiber) || __role(fiber) !== wantedRole) return;
      var accessibleName = typeTextAccessibleName(fiber);
      if (accessibleName != null && __match(accessibleName, { value: opts.name, exact: opts.exact === true })) {
        addVisibleSource({
          fiber: fiber,
          evidence: {
            testID: props.testID,
            accessibleName: accessibleName,
            role: wantedRole,
            placeholder: props.placeholder,
            selectorBundle: {
              testID: props.testID,
              accessibleName: accessibleName,
              role: wantedRole,
              placeholder: props.placeholder
            }
          }
        });
      }
    }

    var completed = new WeakSet();
    forEachTypeTextRoot(function(rootFiber) {
      if (state.truncated) return TYPE_TEXT_ABORT;
      var localSeen = new WeakSet();
      if (!consumeWork()) return TYPE_TEXT_ABORT;
      var stack = [rootFiber];
      var inheritStack = [ELIGIBILITY_CLEAR];
      while (stack.length > 0 && !state.truncated) {
        var node = stack.pop();
        var nodeInherited = inheritStack.pop();
        if (!consumeWork()) break;
        if (!consumeWork()) break;
        if (localSeen.has(node)) {
          state.truncated = true;
          state.reason = 'cycle';
          break;
        }
        localSeen.add(node);
        if (completed.has(node)) continue;
        completed.add(node);
        state.visitedFibers++;
        collectSource(node, nodeInherited);
        if (state.truncated) break;
        addCandidate(node, nodeInherited);
        if (state.truncated) break;
        if (node.sibling) {
          if (!consumeWork()) break;
          stack.push(node.sibling);
          inheritStack.push(nodeInherited);
        }
        if (node.child) {
          if (!consumeWork()) break;
          stack.push(node.child);
          inheritStack.push(eligibilityDescend(nodeInherited, node));
        }
      }
      return state.truncated ? TYPE_TEXT_ABORT : null;
    });

    if (state.truncated) return typeTextTruncation(state);
    if (selectorKind === 'accessibilityLabel') {
      sources = exactSources.length > 0
        ? exactSources
        : (normalizedSources.length > 0 ? normalizedSources : containsSources);
    }
    if (sources.length === 0) {
      return {
        error: 'Component not found',
        selector: selector,
        hint: 'Use cdp_component_tree to verify the component is mounted, or pass a more specific selector.'
      };
    }

    function nearestSource(candidate) {
      var cursor = candidate.fiber;
      var returnSeen = new WeakSet();
      while (cursor) {
        if (!consumeWork()) return null;
        if (!consumeWork()) return null;
        if (returnSeen.has(cursor)) {
          state.truncated = true;
          state.reason = 'cycle';
          return null;
        }
        returnSeen.add(cursor);
        for (var sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
          if (!consumeWork()) return null;
          if (sameTypeTextFiber(cursor, sources[sourceIndex].fiber)) return sources[sourceIndex];
        }
        if (!consumeWork()) return null;
        cursor = cursor.return;
      }
      return null;
    }

    var bindings = [];
    for (var candidateIndex = 0; candidateIndex < candidates.length && !state.truncated; candidateIndex++) {
      var candidate = candidates[candidateIndex];
      var source = nearestSource(candidate);
      if (source) {
        bindings.push({
          candidateFiber: candidate.fiber,
          candidateInherited: candidate.inherited,
          candidateAlternate: candidate.alternate,
          sourceFiber: source.fiber,
          contract: candidate.contract,
          handler: candidate.handler,
          component: candidate.name,
          candidateTestID: candidate.props.testID,
          sourceEvidence: source.evidence,
          controlled: !opts.omitValue && typeof candidate.props.value === 'string',
          valueBefore: !opts.omitValue && typeof candidate.props.value === 'string' ? candidate.props.value : null
        });
      }
    }

    function bindingDescendsFrom(descendant, ancestor) {
      var cursor = descendant.candidateFiber.return;
      var returnSeen = new WeakSet();
      while (cursor) {
        if (!consumeWork()) return false;
        if (returnSeen.has(cursor)) {
          state.truncated = true;
          state.reason = 'cycle';
          return false;
        }
        returnSeen.add(cursor);
        if (sameTypeTextFiber(cursor, ancestor.candidateFiber)) return true;
        cursor = cursor.return;
      }
      return false;
    }

    // RN TextInput renders one element as a composite fiber plus its host child sharing one handler; keep the deepest (press's match-deepest-only rule).
    function collapseLineageBindings(all) {
      return all.filter(function(binding) {
        return !all.some(function(other) {
          return !state.truncated
            && other !== binding
            && other.handler === binding.handler
            && other.contract === binding.contract
            && bindingDescendsFrom(other, binding);
        });
      });
    }

    if (!state.truncated && bindings.length > 1) bindings = collapseLineageBindings(bindings);

    if (state.truncated) return typeTextTruncation(state);
    if (bindings.length > 1) {
      var ambiguousHandler = bindings[0].contract === 'onChangeText:string' ? 'onChangeText' : 'onChange';
      for (var handlerIndex = 1; handlerIndex < bindings.length; handlerIndex++) {
        var nextHandler = bindings[handlerIndex].contract === 'onChangeText:string' ? 'onChangeText' : 'onChange';
        if (nextHandler !== ambiguousHandler) {
          ambiguousHandler = 'mixed';
          break;
        }
      }
      return {
        error: 'Ambiguous typeText resolution',
        testID: opts.testID,
        handler: ambiguousHandler,
        count: bindings.length,
        candidates: bindings.slice(0, 5).map(function(binding) {
          return {
            component: binding.component,
            testID: binding.candidateTestID,
            handler: binding.contract === 'onChangeText:string' ? 'onChangeText' : 'onChange',
            contract: binding.contract
          };
        }),
        hint: 'Multiple distinct typeable handlers match this selector. Pass a more specific testID for the inner TextInput.'
      };
    }

    return {
      binding: bindings.length === 1 ? bindings[0] : null,
      sourceCount: sources.length,
      sourceFibers: sources.map(function(source) { return source.fiber; }),
      sources: sources,
      firstSource: sources[0].fiber,
      state: state
    };
  }

  function textInputDesignationDisabled(candidateProps) {
    return candidateProps.disabled === true
      || candidateProps.editable === false
      || candidateProps.readOnly === true
      || (candidateProps.accessibilityState && candidateProps.accessibilityState.disabled === true);
  }

  function textInputDesignationInteractivity(input, selector) {
    var current = input;
    var seen = new WeakSet();
    var depth = 0;
    while (current && depth < 1000) {
      if (seen.has(current)) {
        return {
          error: 'TextInput designation interactivity resolution truncated',
          code: 'ASSERTION_FAILED',
          testID: selector,
          focusOnly: true,
          truncated: true
        };
      }
      seen.add(current);
      if (isSubtreeInaccessible(current)) {
        return {
          error: 'TextInput designation target is hidden or occluded',
          testID: selector,
          focusOnly: true
        };
      }
      var props = current.memoizedProps || {};
      var pointerEvents = props.pointerEvents;
      if (
        current === input
        && (pointerEvents === 'none' || pointerEvents === 'box-none')
      ) {
        return {
          error: 'TextInput designation target is not user-interactable with pointerEvents="' + pointerEvents + '"',
          testID: selector,
          focusOnly: true
        };
      }
      if (
        current !== input
        && (pointerEvents === 'none' || pointerEvents === 'box-only')
      ) {
        return {
          error: 'TextInput designation target is blocked beneath pointerEvents="' + pointerEvents + '"',
          testID: selector,
          focusOnly: true
        };
      }
      current = current.return;
      depth++;
    }
    if (current) {
      return {
        error: 'TextInput designation interactivity resolution truncated',
        code: 'ASSERTION_FAILED',
        testID: selector,
        focusOnly: true,
        truncated: true
      };
    }
    return null;
  }

  var activeTextInputDesignation = null;
  var textInputDesignationSequence = 0;

  function retainTextInputDesignation(input, selector) {
    textInputDesignationSequence++;
    var token = Date.now().toString(36) + '-' + textInputDesignationSequence.toString(36);
    activeTextInputDesignation = {
      token: token,
      input: input,
      selector: selector
    };
    return token;
  }

  function consumeTextInputDesignation(token, selector) {
    var designation = activeTextInputDesignation;
    if (
      !designation
      || designation.token !== token
      || designation.selector !== selector
    ) {
      return null;
    }
    activeTextInputDesignation = null;
    return designation;
  }

  function designateTextInputPress(found, selector) {
    var designation = resolveTextInputDesignation(found, selector);
    if (!designation) return null;
    if (designation.success === true) {
      designation.designationToken = retainTextInputDesignation(designation.inputFiber, selector);
      delete designation.inputFiber;
    }
    return JSON.stringify(designation);
  }

  function releaseInputDesignation(token) {
    var released = !!activeTextInputDesignation
      && activeTextInputDesignation.token === token;
    if (released) activeTextInputDesignation = null;
    return JSON.stringify({ released: released });
  }

  function isSameDesignatedInput(left, right) {
    return !!left && !!right && (
      left === right
      || left.alternate === right
      || right.alternate === left
    );
  }

  function resolveTextInputDesignation(owner, selector) {
    if (!owner) return null;
    var designationStack = [owner];
    var designationSeen = new WeakSet();
    var designationMatches = [];
    var designationInputs = [];
    var designationWork = 0;
    while (designationStack.length > 0 && designationWork < 20000) {
      var designationFiber = designationStack.pop();
      if (designationSeen.has(designationFiber)) continue;
      designationSeen.add(designationFiber);
      designationWork++;
      var designationProps = designationFiber.memoizedProps || {};
      var designationMatchesSelector = designationProps.testID === selector
        || designationProps.nativeID === selector;
      if (designationMatchesSelector) {
        designationMatches.push(designationFiber);
      }
      if (
        designationFiber.tag === 5
        && typeof designationFiber.type === 'string'
        && hostKind(designationFiber) === 'textinput'
        && designationMatchesSelector
      ) {
        designationInputs.push(designationFiber);
      }
      var designationChild = designationFiber.child;
      while (designationChild) {
        designationStack.push(designationChild);
        designationChild = designationChild.sibling;
      }
    }
    if (designationStack.length > 0) {
      return {
        error: 'TextInput designation resolution truncated',
        code: 'ASSERTION_FAILED',
        testID: selector,
        focusOnly: true,
        truncated: true
      };
    }
    if (designationInputs.length > 1) {
      return {
        error: 'Ambiguous TextInput designation target',
        testID: selector,
        count: designationInputs.length,
        focusOnly: true
      };
    }
    if (designationInputs.length !== 1) return null;
    var designationInput = designationInputs[0];
    var designationInputProps = designationInput.memoizedProps || {};
    var designationLineage = new WeakSet();
    var designationLineageFiber = designationInput;
    var designationLineageDepth = 0;
    while (designationLineageFiber && designationLineageDepth < 1000) {
      if (designationLineage.has(designationLineageFiber)) {
        return {
          error: 'TextInput designation resolution truncated',
          code: 'ASSERTION_FAILED',
          testID: selector,
          focusOnly: true,
          truncated: true
        };
      }
      designationLineage.add(designationLineageFiber);
      if (isSameDesignatedInput(designationLineageFiber, owner)) break;
      designationLineageFiber = designationLineageFiber.return;
      designationLineageDepth++;
    }
    if (!isSameDesignatedInput(designationLineageFiber, owner)) {
      return {
        error: 'TextInput designation resolution truncated',
        code: 'ASSERTION_FAILED',
        testID: selector,
        focusOnly: true,
        truncated: true
      };
    }
    for (var designationIndex = 0; designationIndex < designationMatches.length; designationIndex++) {
      var designationMatch = designationMatches[designationIndex];
      if (!designationLineage.has(designationMatch) && !designationLineage.has(designationMatch.alternate)) {
        return {
          error: 'Ambiguous TextInput designation target',
          testID: selector,
          count: designationMatches.length,
          focusOnly: true
        };
      }
      if (textInputDesignationDisabled(designationMatch.memoizedProps || {})) {
        return {
          error: 'TextInput is disabled or non-editable',
          component: typeTextFiberName(designationInput),
          testID: selector,
          focusOnly: true
        };
      }
    }
    var designationInteractivity = textInputDesignationInteractivity(
      designationInput,
      selector
    );
    if (designationInteractivity) return designationInteractivity;
    if (typeof designationInputProps.onPress === 'function') return null;
    return {
      success: true,
      action: 'designateTextInput',
      component: typeTextFiberName(designationInput),
      testID: selector,
      focusOnly: true,
      inputFiber: designationInput
    };
  }

  function executeTypeTextTransaction(opts) {
    var designationSelector = opts.testID;
    var boundDesignation = null;
    if (opts.requireLiveInputDesignation === true) {
      boundDesignation = consumeTextInputDesignation(
        opts.designationToken,
        designationSelector
      );
      if (!boundDesignation) {
        return {
          error: 'TextInput designation no longer owns the exact host input',
          code: 'INTERACTION_NOT_ACTUATED',
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
      var liveFrontmost;
      try {
        liveFrontmost = JSON.parse(isTestIdFrontmost(designationSelector));
      } catch (_) {
        liveFrontmost = null;
      }
      if (!liveFrontmost || liveFrontmost.visible !== true) {
        return {
          error: liveFrontmost && liveFrontmost.reason
            ? liveFrontmost.reason
            : 'TextInput designation frontmost state is unreadable',
          code: liveFrontmost && liveFrontmost.code
            ? liveFrontmost.code
            : (liveFrontmost && liveFrontmost.matchCount > 1
              ? 'AMBIGUOUS_TESTID'
              : 'ASSERTION_FAILED'),
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
    }
    var resolution = resolveTypeTextTarget(opts);
    if (resolution.error) return resolution;
    var binding = resolution.binding;
    var selector = opts.testID || opts.accessibilityLabel;
    if (!binding) {
      return {
        error: 'Component has no onChangeText or onChange handler',
        component: typeTextFiberName(resolution.firstSource),
        testID: selector,
        handlerCalled: false,
        visitedFibers: resolution.state.visitedFibers,
        hint: 'Inspected every matching fiber and its bounded ownership graph — no typeable handler exists. Use cdp_component_tree to inspect the field, or pass the inner field testID directly.'
      };
    }
    if (opts.requireLiveInputDesignation === true) {
      var designationSourceProps = binding.sourceFiber.memoizedProps || {};
      if (
        typeof designationSelector !== 'string'
        || !designationSelector
        || hostKind(binding.sourceFiber) !== 'textinput'
        || (
          designationSourceProps.testID !== designationSelector
          && designationSourceProps.nativeID !== designationSelector
        )
      ) {
        return {
          error: 'TextInput designation no longer resolves to the exact host input',
          code: 'INTERACTION_NOT_ACTUATED',
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
      var designationOwner = binding.sourceFiber;
      var designationOwnerCursor = binding.sourceFiber.return;
      var designationOwnerSeen = new WeakSet();
      var designationOwnerDepth = 0;
      while (designationOwnerCursor && designationOwnerDepth < 1000) {
        if (designationOwnerSeen.has(designationOwnerCursor)) {
          designationOwnerCursor = null;
          designationOwnerDepth = 1000;
          break;
        }
        designationOwnerSeen.add(designationOwnerCursor);
        designationOwnerDepth++;
        var designationOwnerProps = designationOwnerCursor.memoizedProps || {};
        if (
          designationOwnerProps.testID === designationSelector
          || designationOwnerProps.nativeID === designationSelector
        ) {
          designationOwner = designationOwnerCursor;
        }
        designationOwnerCursor = designationOwnerCursor.return;
      }
      if (designationOwnerCursor || designationOwnerDepth >= 1000) {
        return {
          error: 'TextInput designation ownership resolution truncated',
          code: 'ASSERTION_FAILED',
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
      var liveDesignation = resolveTextInputDesignation(designationOwner, designationSelector);
      if (!liveDesignation || liveDesignation.success !== true) {
        if (!liveDesignation) {
          return {
            error: 'TextInput designation no longer resolves to the exact host input',
            code: 'INTERACTION_NOT_ACTUATED',
            testID: designationSelector,
            focusOnly: true,
            handlerCalled: false
          };
        }
        liveDesignation.code = liveDesignation.truncated === true
          ? 'ASSERTION_FAILED'
          : 'INTERACTION_NOT_ACTUATED';
        liveDesignation.handlerCalled = false;
        return liveDesignation;
      }
      if (
        !isSameDesignatedInput(boundDesignation.input, binding.sourceFiber)
        || !isSameDesignatedInput(boundDesignation.input, liveDesignation.inputFiber)
      ) {
        return {
          error: 'TextInput designation no longer owns the exact host input',
          code: 'INTERACTION_NOT_ACTUATED',
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
      var designationCandidateProps = binding.candidateFiber.memoizedProps || {};
      if (textInputDesignationDisabled(designationCandidateProps)) {
        return {
          error: 'TextInput is disabled or non-editable',
          code: 'INTERACTION_NOT_ACTUATED',
          component: binding.component,
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
      if (binding.controlled !== true) {
        return {
          error: 'TextInput designation is uncontrolled or unreadable',
          code: 'INTERACTION_NOT_ACTUATED',
          testID: designationSelector,
          focusOnly: true,
          handlerCalled: false
        };
      }
    }
    var text = opts.text !== undefined ? opts.text : '';
    if (opts.testID) {
      for (var typeSourceIndex = 0; typeSourceIndex < resolution.sources.length; typeSourceIndex++) {
        var typeSource = resolution.sources[typeSourceIndex];
        var typeSourceEligibility = eligibilityDisabled(typeSource.fiber)
          ? { eligible: false, error: 'Component is disabled', reason: 'disabled exact-ID fiber' }
          : eligibilityHiddenVerdict(typeSource.fiber, typeSource.inherited, opts.testID);
        if (!typeSourceEligibility.eligible) {
          return {
            error: typeSourceEligibility.error,
            reason: typeSourceEligibility.reason,
            code: 'INTERACTION_NOT_ACTUATED',
            component: typeTextFiberName(typeSource.fiber),
            testID: selector,
            handlerCalled: false
          };
        }
      }
      var typeCandidateEligibility = eligibilityDisabled(binding.candidateFiber)
        ? { eligible: false, error: 'Component is disabled', reason: 'disabled exact-ID fiber' }
        : eligibilityVerdict(binding.candidateFiber, binding.candidateInherited, opts.testID);
      if (!typeCandidateEligibility.eligible) {
        return {
          error: typeCandidateEligibility.error,
          reason: typeCandidateEligibility.reason,
          code: 'INTERACTION_NOT_ACTUATED',
          component: binding.component,
          testID: selector,
          handlerCalled: false
        };
      }
    }
    if (boundDesignation) text = (binding.valueBefore || '') + text;
    try {
      if (binding.contract === 'onChangeText:string') binding.handler(text);
      else binding.handler({ nativeEvent: { text: text } });
    } catch (e) {
      return {
        success: false,
        action_executed: true,
        handler_error: (e && e.message || String(e)),
        component: binding.component,
        testID: selector,
        hint: 'The action was dispatched but the app handler threw — the screen may now be in an error state. Check cdp_error_log before continuing.'
      };
    }
    return {
      success: true,
      action: 'typeText',
      component: binding.component,
      testID: selector,
      text: text,
      handlerCalled: binding.contract === 'onChangeText:string' ? 'onChangeText' : 'onChange',
      controlled: binding.controlled,
      valueBefore: binding.valueBefore,
      resolvedFrom: binding.component + (binding.candidateTestID ? ' [testID="' + binding.candidateTestID + '"]' : ''),
      visitedFibers: resolution.state.visitedFibers,
      selectorBundle: binding.sourceEvidence.selectorBundle || undefined
    };
  }

  // UI Interaction
  function interact(opts) {
    opts = opts || {};
    var action = opts.action;
    var selector = opts.testID || opts.accessibilityLabel;
    var matchField = opts.testID ? 'testID' : 'accessibilityLabel';
    var isLabelMatch = matchField === 'accessibilityLabel';
    var ladderTarget = null;

    if (!action) return JSON.stringify({ error: 'action is required' });

    // GH #525 — walkUp is a narrowly bounded press-only opt-in.
    if (opts.walkUp === true && action !== 'press') {
      return JSON.stringify({
        error: 'walkUp is only supported for action:"press"',
        requestedAction: action,
        hint: 'typeText/setFieldValue already resolve wrapper indirection with their own bounded walks.'
      });
    }

    if (action === 'typeText') {
      return JSON.stringify(executeTypeTextTransaction(opts));
    }

    // Task 7 — ladder routing. typeText reuses the established placeholder
    // and role+name facts; its text argument remains the value to enter.
    if (!selector && (opts.role || opts.name || opts.text || opts.placeholder)) {
      if (action !== 'press') {
        return JSON.stringify({
          error: 'Ladder selectors support press, plus placeholder or role+name for typeText',
          requestedAction: opts.action,
          hint: 'Use a testID or accessibilityLabel for longPress, scroll, or setFieldValue.'
        });
      }
      // GH #525 — walkUp's bounded search and ambiguity refusal belong to the
      // testID/accessibilityLabel path; refuse instead of silently dropping it.
      if (opts.walkUp === true) {
        return JSON.stringify({
          error: 'walkUp is only supported with a testID or accessibilityLabel selector',
          hint: 'Ladder selectors already press the nearest onPress ancestor; drop walkUp, or target the component by testID to get the bounded walk.'
        });
      }
      var ladderResult = resolveLadder(JSON.stringify({
        role: opts.role, name: opts.name, text: opts.text,
        placeholder: opts.placeholder, exact: opts.exact, includeHidden: opts.includeHidden
      }));
      var parsed = JSON.parse(ladderResult);
      if (!parsed.found) return ladderResult;

      var targetFiber = __resolveLadderFiber(opts);
      if (!targetFiber) return JSON.stringify({ error: 'Component not found' });

      var pressFiber = targetFiber;
      while (pressFiber) {
        var pf = pressFiber.memoizedProps;
        if (pf && typeof pf.onPress === 'function') break;
        pressFiber = pressFiber.return;
      }
      if (!pressFiber) {
        return JSON.stringify({ error: 'Component has no onPress handler', bundle: parsed.bundle });
      }
      var pName = (pressFiber.type && (typeof pressFiber.type === 'string'
        ? pressFiber.type
        : (pressFiber.type.displayName || pressFiber.type.name))) || 'Unknown';
      try {
        pressFiber.memoizedProps.onPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'press', component: pName, bundle: parsed.bundle });
      } catch (e) {
        return JSON.stringify({ error: 'onPress threw', message: e && e.message, component: pName });
      }
    }

    if (!selector && !ladderTarget) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });
    if (ladderTarget) isLabelMatch = false;

    var found = ladderTarget;
    var findCount = 0;
    // Fail-closed truncation budget. Mirrors the salient-digest budget
    // (Math.min(cap, perRoot * roots)) and its wall-clock guard
    // (Date.now() - start < 3000). rootsSeeded is counted as roots are fed
    // into findFiber via forEachRootFiber below. On trip we set findTruncated
    // and unwind WITHOUT recording any match, so interact() returns a
    // structured "Resolution truncated" error and NEVER presses a partial pick.
    var findTruncated = false;
    var findStart = Date.now();
    var rootsSeeded = 0;
    var findBudget = 8000; // recomputed once rootsSeeded is known

    // B5/D684: testID stays strict + early-return (fast happy path).
    // accessibilityLabel uses tiered matching: exact === → normalized
    // (trim+collapse-ws+lowercase) → substring contains. Ambiguity in the
    // looser tiers surfaces as a structured error so we never silently pick
    // among multiple "Continue" buttons.
    function norm(v) {
      return String(v).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').toLowerCase();
    }
    var normSelector = isLabelMatch ? norm(selector) : null;
    var exactMatches = [];
    var normMatches = [];
    var containsMatches = [];
    // GH #525 — walkUp collects every strict-testID match so duplicates can refuse.
    var walkUpCollect = opts.walkUp === true && !isLabelMatch;
    var walkUpMatches = [];
    var walkUpInherited = new WeakMap();
    var findSeen = null;
    var findCycleDetected = false;

    function findFiber(fiber) {
      var findStack = [fiber];
      var findInheritStack = [ELIGIBILITY_CLEAR];
      while (findStack.length > 0) {
        var current = findStack.pop();
        var currentInherited = findInheritStack.pop();
        if (findTruncated) return;
        if (findSeen.has(current)) {
          findCycleDetected = true;
          continue;
        }
        findSeen.add(current);
        findCount++;
        if (findCount > findBudget || (Date.now() - findStart) > 3000) {
          findTruncated = true;
          return;
        }
        var props = current.memoizedProps;
        if (props) {
          if (!isLabelMatch) {
            if (props[matchField] === selector) {
              if (walkUpCollect) {
                walkUpMatches.push(current);
                walkUpInherited.set(current, currentInherited);
              } else {
                found = current;
                return;
              }
            }
          } else {
            var raw = props.accessibilityLabel;
            if (raw !== undefined && raw !== null && raw !== '') {
              if (raw === selector) {
                exactMatches.push(current);
              } else {
                var nv = norm(raw);
                if (nv === normSelector) {
                  normMatches.push(current);
                } else if (nv.indexOf(normSelector) >= 0) {
                  containsMatches.push(current);
                }
              }
            }
          }
        }
        if (current.sibling) {
          findStack.push(current.sibling);
          findInheritStack.push(currentInherited);
        }
        if (current.child) {
          findStack.push(current.child);
          findInheritStack.push(eligibilityDescend(currentInherited, current));
        }
      }
    }

    // B145: walk root.current across every renderer until the testID is
    // found. Previously only the first renderer's roots were searched.
    // For label matching, walk ALL renderers (no short-circuit) so duplicate
    // labels split across renderers (LogBox vs Fabric) are detected.
    // First pass purely to size the budget by how many roots we'll seed,
    // so a multi-renderer tree (LogBox + Fabric + Reanimated) gets proportional
    // headroom — same shape as the digest's Math.min(cap, perRoot * roots).
    forEachRootFiber(function() { rootsSeeded++; return null; });
    findBudget = Math.min(40000, 8000 * Math.max(1, rootsSeeded));
    forEachRootFiber(function(rootFiber) {
      if (findTruncated) return found;
      if (!isLabelMatch && found) return found;
      findSeen = new WeakSet();
      findFiber(rootFiber);
      return isLabelMatch ? null : found;
    });

    // Fail-closed: a tripped budget means the scan is INCOMPLETE. Never fall
    // through to the tier[0] pick, the "Component not found" branch, or onPress
    // — any of those would act on a partial view of the tree.
    if (findTruncated) {
      return JSON.stringify({
        error: 'Resolution truncated',
        truncated: true,
        scanned: findCount,
        hint: 'increase budget or scope with a container/anchor'
      });
    }

    if (isLabelMatch) {
      var tier = exactMatches.length > 0
        ? exactMatches
        : (normMatches.length > 0 ? normMatches : containsMatches);
      if (tier.length === 0) {
        return JSON.stringify({
          error: 'Component not found',
          selector: selector,
          matchField: matchField,
          hint: 'Tried exact, case/whitespace-normalized, and substring match. Use cdp_component_tree filter:"' + selector + '" to verify the label is mounted, or pass a testID instead.'
        });
      }
      if (tier.length > 1) {
        var descriptors = [];
        for (var di = 0; di < tier.length && di < 10; di++) {
          var dp = tier[di].memoizedProps || {};
          var dt = (tier[di].type && (tier[di].type.displayName || tier[di].type.name)) || 'Unknown';
          descriptors.push({
            component: dt,
            testID: dp.testID,
            accessibilityLabel: dp.accessibilityLabel,
          });
        }
        return JSON.stringify({
          error: 'Ambiguous component match',
          selector: selector,
          matchField: matchField,
          count: tier.length,
          matches: descriptors,
          hint: 'Multiple components match this accessibilityLabel. Add a testID to the target component for unambiguous matching.'
        });
      }
      found = tier[0];
    }

    if (walkUpCollect && walkUpMatches.length > 0) found = walkUpMatches[0];
    if (ladderTarget) found = ladderTarget;

    if (!found) {
      return JSON.stringify({
        error: 'Component not found',
        selector: selector,
        hint: 'Use cdp_component_tree to verify the component is mounted and the testID is correct.'
      });
    }

    var props = found.memoizedProps || {};
    var typeName = (found.type && (found.type.displayName || found.type.name)) || 'Unknown';
    var executedName = typeName;

    try {
      if (action === 'press' && opts.walkUp === true) {
        // 8 levels covers ~2 JSX wrappers: one wrapper is ~3 fibers under NativeWind CssInterop.
        var WALK_UP_MAX = 8;
        var walkFiberName = function(f) {
          return (f && f.type && (typeof f.type === 'string'
            ? f.type
            : (f.type.displayName || f.type.name))) || 'Unknown';
        };
        // A real tap on a text field never reaches an ancestor Pressable, so designation wins over the walk.
        if (opts.allowInputDesignation === true && opts.testID) {
          var walkDesignation = designateTextInputPress(found, selector);
          if (walkDesignation) return walkDesignation;
        }
        var walkAncestorOf = function(outer, inner) {
          var node = inner.return;
          var steps = 0;
          while (node && steps < 1000) {
            if (sameFiber(node, outer)) return true;
            node = node.return;
            steps++;
          }
          return false;
        };
        var walkInertView = function(f) {
          if (f.type !== 'RCTView') return false;
          var p = f.memoizedProps || {};
          if (p.accessible === true || p.focusable === true || (p.accessibilityRole && p.accessibilityRole !== 'none')
            || (p.role && p.role !== 'none' && p.role !== 'presentation')) return false;
          var keys = Object.keys(p);
          for (var ki = 0; ki < keys.length; ki++) {
            if (/^on(Press|LongPress|Click|DoubleClick|Touch|Responder|.*ShouldSetResponder|Pointer|Key|Accessibility|MagicTap)/.test(keys[ki])
              && p[keys[ki]] != null) return false;
          }
          return true;
        };
        var walkForwarded = function(a, b) {
          var ap = a.memoizedProps, bp = b.memoizedProps;
          if (!ap || !bp) return false;
          if (ap[matchField] !== selector || bp[matchField] !== selector) return false;
          if (ap.onPress !== bp.onPress) return false;
          return walkAncestorOf(a, b) || walkAncestorOf(b, a);
        };
        var walkSources = walkUpMatches.length > 0 ? walkUpMatches : [found];
        var walkCandidates = [];
        var walkOriginalCandidates = [];
        for (var wi = 0; wi < walkSources.length; wi++) {
          var walkNode = walkSources[wi];
          var walkHops = 0;
          while (walkNode && walkHops <= WALK_UP_MAX) {
            var walkProps = walkNode.memoizedProps;
            if (walkProps && typeof walkProps.onPress === 'function') break;
            walkNode = walkNode.return;
            walkHops++;
          }
          if (!walkNode || walkHops > WALK_UP_MAX) continue;
          walkOriginalCandidates.push({ fiber: walkNode, hops: walkHops, source: walkSources[wi] });
          var existing = null;
          for (var wj = 0; wj < walkCandidates.length; wj++) {
            if (sameFiber(walkCandidates[wj].fiber, walkNode) || walkForwarded(walkCandidates[wj].fiber, walkNode)) {
              existing = walkCandidates[wj];
              break;
            }
          }
          if (existing) {
            if (walkAncestorOf(walkNode, existing.fiber)) existing.fiber = walkNode;
            if (walkHops < existing.hops) { existing.hops = walkHops; existing.source = walkSources[wi]; }
          } else {
            walkCandidates.push({ fiber: walkNode, hops: walkHops, source: walkSources[wi] });
          }
        }
        if (walkCandidates.length === 0) {
          return JSON.stringify({ error: 'Component has no onPress handler', component: walkFiberName(found), testID: selector, walkUpSearched: WALK_UP_MAX });
        }
        var walkSingleHostTarget = function() {
          if (!opts.testID || findCycleDetected) return null;
          var hosts = new Set();
          for (var si = 0; si < walkSources.length; si++) {
            if (walkSources[si].tag === 5) hosts.add(walkSources[si]);
          }
          if (hosts.size !== 1) return null;
          var host = hosts.values().next().value;
          var lineage = [];
          var node = host;
          while (node && lineage.length < 1000) {
            lineage.push(node);
            node = node.return;
          }
          if (node) return null;
          var lineageIndex = function(f) {
            for (var li = 0; li < lineage.length; li++) {
              if (sameFiber(f, lineage[li])) return li;
            }
            return -1;
          };
          for (var si = 0; si < walkSources.length; si++) {
            if (lineageIndex(walkSources[si]) < 0) return null;
          }
          var hostTarget = null;
          var outermost = 0;
          for (var ci = 0; ci < walkOriginalCandidates.length; ci++) {
            var candidate = walkOriginalCandidates[ci];
            var candidateIndex = lineageIndex(candidate.fiber);
            if (candidateIndex < 0 || candidate.fiber.memoizedProps.testID !== selector) return null;
            outermost = Math.max(outermost, candidateIndex);
            if (candidate.source === host) hostTarget = candidate;
          }
          if (!hostTarget) return null;
          for (var li = 1; li <= outermost; li++) {
            if (lineage[li].tag === 5 && !walkInertView(lineage[li])) return null;
          }
          return hostTarget;
        };
        if (walkCandidates.length > 1) {
          var witnessedTarget = walkSingleHostTarget();
          if (witnessedTarget) walkCandidates = [witnessedTarget];
        }
        if (walkCandidates.length > 1) {
          var walkDescriptors = [];
          for (var wk = 0; wk < walkCandidates.length && wk < 10; wk++) {
            var wf = walkCandidates[wk].fiber;
            var wp = wf.memoizedProps || {};
            walkDescriptors.push({
              component: walkFiberName(wf),
              testID: wp.testID
            });
          }
          return JSON.stringify({
            error: 'Ambiguous walkUp press target',
            testID: selector,
            count: walkCandidates.length,
            candidates: walkDescriptors,
            hint: 'Multiple distinct pressable fibers resolve from this testID. Pass the testID of the exact pressable component instead.'
          });
        }
        var walkTarget = walkCandidates[0];
        var walkTargetName = walkFiberName(walkTarget.fiber);
        if (opts.testID) {
          if (eligibilityDisabled(walkTarget.fiber)) {
            return JSON.stringify({ error: 'Component is disabled', reason: 'disabled walk target', component: walkTargetName, testID: selector });
          }
          for (var ws = 0; ws < walkSources.length; ws++) {
            var walkSource = walkSources[ws];
            if (eligibilityDisabled(walkSource)) {
              return JSON.stringify({ error: 'Component is disabled', reason: 'disabled exact-ID fiber', component: walkFiberName(walkSource), testID: selector });
            }
            var walkSourceEligibility = eligibilityVerdict(walkSource, walkUpInherited.get(walkSource), selector);
            if (!walkSourceEligibility.eligible) {
              return JSON.stringify({ error: walkSourceEligibility.error, reason: walkSourceEligibility.reason, component: walkFiberName(walkSource), testID: selector });
            }
          }
        }
        executedName = walkTargetName;
        if (opts.value !== undefined) {
          walkTarget.fiber.memoizedProps.onPress(opts.value);
        } else {
          walkTarget.fiber.memoizedProps.onPress({ nativeEvent: {} });
        }
        var walkResult = { success: true, action: 'press', component: walkTargetName, testID: selector };
        if (opts.value !== undefined) walkResult.value = opts.value;
        if (walkTarget.hops > 0) {
          walkResult.walkedUpFrom = walkFiberName(walkTarget.source);
          walkResult.walkUpLevels = walkTarget.hops;
        }
        return JSON.stringify(walkResult);
      }

      if (action === 'press') {
        if (typeof props.onPress !== 'function') {
          if (opts.allowInputDesignation === true && opts.testID) {
            var pressDesignation = designateTextInputPress(found, selector);
            if (pressDesignation) return pressDesignation;
          }
          return JSON.stringify({ error: 'Component has no onPress handler', component: typeName, testID: selector });
        }
        if (opts.value !== undefined) {
          props.onPress(opts.value);
        } else {
          props.onPress({ nativeEvent: {} });
        }
        var pressResult = { success: true, action: 'press', component: typeName, testID: selector };
        if (opts.value !== undefined) pressResult.value = opts.value;
        return JSON.stringify(pressResult);
      }

      if (action === 'setFieldValue') {
        var fieldName = opts.name;
        var fieldValue = opts.value;
        if (typeof fieldName !== 'string' || fieldName.length === 0) {
          return JSON.stringify({
            error: 'setFieldValue requires opts.name (the RHF field name)',
            testID: selector,
            hint: 'Pass the same \`name\` string you used in \`useController({ name })\` or \`<Controller name="..." />\`.'
          });
        }
        var shouldValidate = opts.shouldValidate !== false;
        var shouldDirty = opts.shouldDirty !== false;

        var FORM_RESOLUTION_WORK_LIMIT = 200;
        function looksLikeUseFormReturn(v) {
          return (
            v && typeof v === 'object'
            && typeof v.setValue === 'function'
            && typeof v.getValues === 'function'
            && v.control && typeof v.control === 'object'
          );
        }
        var ancestor = found;
        var ancestorVisits = 0;
        var formResolutionWork = 0;
        var formResolutionReason = null;
        var formReturn = null;
        var formResolution = null;
        var ancestorSeen = new WeakSet();
        var nearestExplicitControl = null;
        var hookFormReturns = [];

        function consumeFormWork() {
          formResolutionWork++;
          if (formResolutionWork > FORM_RESOLUTION_WORK_LIMIT) {
            formResolutionReason = 'work-limit';
            return false;
          }
          return true;
        }

        function pushIdentityUnique(list, value) {
          for (var identityIndex = 0; identityIndex < list.length; identityIndex++) {
            if (list[identityIndex] === value) return;
          }
          list.push(value);
        }

        while (ancestor && !formResolutionReason) {
          if (!consumeFormWork()) break;
          if (ancestorSeen.has(ancestor)) {
            formResolutionReason = 'cycle';
            break;
          }
          ancestorSeen.add(ancestor);
          ancestorVisits++;
          var aProps = ancestor.memoizedProps || {};
          if (!nearestExplicitControl && aProps.control && typeof aProps.control === 'object') {
            nearestExplicitControl = aProps.control;
          }
          if (aProps && looksLikeUseFormReturn(aProps.value)) {
            if (!nearestExplicitControl || aProps.value.control === nearestExplicitControl) {
              formReturn = aProps.value;
              formResolution = 'form-provider';
              break;
            }
          }

          var hook = ancestor.memoizedState;
          var hookSeen = new WeakSet();
          while (hook && typeof hook === 'object' && !formResolutionReason) {
            if (!consumeFormWork()) break;
            if (hookSeen.has(hook)) {
              formResolutionReason = 'cycle';
              break;
            }
            hookSeen.add(hook);
            var hookValue = hook.memoizedState;
            if (looksLikeUseFormReturn(hookValue)) pushIdentityUnique(hookFormReturns, hookValue);
            if (hookValue && typeof hookValue === 'object' && looksLikeUseFormReturn(hookValue.current)) {
              pushIdentityUnique(hookFormReturns, hookValue.current);
            }
            hook = hook.next;
          }
          ancestor = ancestor.return;
        }

        if (formResolutionReason) {
          return JSON.stringify({
            error: 'setFieldValue resolution truncated',
            truncated: true,
            reason: formResolutionReason,
            work: formResolutionWork,
            workLimit: FORM_RESOLUTION_WORK_LIMIT,
            ancestorVisits: ancestorVisits,
            hint: 'The bounded FormProvider/useForm owner scan was incomplete; setValue was not called.'
          });
        }

        if (!formReturn) {
          var matchingHookReturns = [];
          for (var hfi = 0; hfi < hookFormReturns.length; hfi++) {
            if (nearestExplicitControl && hookFormReturns[hfi].control === nearestExplicitControl) {
              pushIdentityUnique(matchingHookReturns, hookFormReturns[hfi]);
            }
          }
          if (matchingHookReturns.length === 1) {
            formReturn = matchingHookReturns[0];
            formResolution = 'control-prop-hook';
          } else if (matchingHookReturns.length > 1) {
            return JSON.stringify({
              error: 'setFieldValue: ambiguous useForm control ownership',
              testID: selector,
              count: matchingHookReturns.length,
              ancestorVisits: ancestorVisits,
              hint: 'Multiple useForm hook returns own the explicit control prop. Add a more specific testID inside the intended Controller subtree.'
            });
          }
        }
        if (!formReturn) {
          return JSON.stringify({
            error: 'setFieldValue: no FormProvider ancestor or matching useForm control found',
            testID: selector,
            ancestorVisits: ancestorVisits,
            hint: 'The target is not wrapped in <FormProvider>, and no ancestor useForm hook return matched the nearest explicit control prop by identity. If you only need to fire onChangeText/onChange, use action="typeText" instead.'
          });
        }
        var coercedToString = false;
        if (typeof fieldValue === 'number') {
          var currentValue;
          try { currentValue = formReturn.getValues(fieldName); } catch (e2) { currentValue = undefined; }
          if (typeof currentValue === 'string') {
            fieldValue = String(fieldValue);
            coercedToString = true;
          }
        }
        try {
          formReturn.setValue(fieldName, fieldValue, { shouldValidate: shouldValidate, shouldDirty: shouldDirty });
        } catch (e) {
          return JSON.stringify({
            error: 'setFieldValue: setValue threw: ' + (e && e.message ? e.message : String(e)),
            testID: selector,
            name: fieldName,
            hint: 'The form was found but its setValue rejected the call. Common causes: name does not exist on the form, value type mismatch, or the form is in a transitioning state.'
          });
        }
        return JSON.stringify({
          success: true,
          action: 'setFieldValue',
          testID: selector,
          name: fieldName,
          value: fieldValue,
          coercedToString: coercedToString,
          shouldValidate: shouldValidate,
          shouldDirty: shouldDirty,
          ancestorVisits: ancestorVisits,
          resolvedFrom: formResolution
        });
      }

      if (action === 'scroll') {
        var x = opts.scrollX !== undefined ? opts.scrollX : 0;
        var y = opts.scrollY !== undefined ? opts.scrollY : 300;
        var animated = opts.animated !== false;
        var stateNode = found.stateNode;

        if (stateNode && typeof stateNode.scrollTo === 'function') {
          stateNode.scrollTo({ x: x, y: y, animated: animated });
          return JSON.stringify({ success: true, action: 'scroll', method: 'scrollTo', component: typeName, testID: selector, x: x, y: y });
        }

        if (typeof props.onScroll === 'function') {
          props.onScroll({
            nativeEvent: {
              contentOffset: { x: x, y: y },
              contentSize: { width: 0, height: 0 },
              layoutMeasurement: { width: 0, height: 0 }
            }
          });
          return JSON.stringify({ success: true, action: 'scroll', method: 'onScroll', component: typeName, testID: selector, x: x, y: y, note: 'Synthetic event — does not physically scroll the native view' });
        }

        return JSON.stringify({ error: 'Component has no scrollTo method or onScroll handler', component: typeName, testID: selector });
      }

      if (action === 'longPress') {
        if (typeof props.onLongPress !== 'function') {
          return JSON.stringify({ error: 'Component has no onLongPress handler', component: typeName, testID: selector });
        }
        props.onLongPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'longPress', component: typeName, testID: selector });
      }

      return JSON.stringify({ error: 'Unknown action: ' + action });
    } catch(e) {
      return JSON.stringify({
        success: false, action_executed: true,
        handler_error: (e && e.message || String(e)),
        component: executedName, testID: selector,
        hint: 'The action was dispatched but the app handler threw — the screen may now be in an error state. Check cdp_error_log before continuing.'
      });
    }
  }

  function dispatchAction(opts) {
    opts = opts || {};
    var actionType = opts.action;
    var payload = opts.payload;
    var readPath = opts.readPath;

    if (!actionType) return JSON.stringify({ __agent_error: 'action is required (e.g. "tasks/softDelete")' });

    var store = findProviderStore(function(name, props) {
      return name === 'Provider' && props && props.store && props.store.dispatch
        ? props.store
        : null;
    });

    if (!store && globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.dispatch) {
      store = globalThis.__REDUX_STORE__;
    }

    if (!store) {
      return JSON.stringify({ __agent_error: 'No Redux store with dispatch found. Zustand stores do not support dispatch.' });
    }

    try {
      store.dispatch({ type: actionType, payload: payload });
    } catch(e) {
      return JSON.stringify({ __agent_error: 'Dispatch failed: ' + (e && e.message || String(e)) });
    }

    if (readPath) {
      var state = store.getState();
      var parts = readPath.split('.');
      var cur = state;
      for (var i = 0; i < parts.length; i++) {
        cur = cur && cur[parts[i]];
        if (cur === undefined) {
          return safeStringify({ dispatched: true, readError: 'Path not found: ' + readPath });
        }
      }
      return safeStringify({ dispatched: true, state: cur });
    }

    return JSON.stringify({ dispatched: true });
  }

  function findNavRef() {
    if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.navigate) return globalThis.__NAV_REF__;
    if (globalThis.__NAVIGATION_REF__ && globalThis.__NAVIGATION_REF__.navigate) return globalThis.__NAVIGATION_REF__;
    if (globalThis.navigationRef && globalThis.navigationRef.navigate) return globalThis.navigationRef;
    // B145: scan every renderer for a NavigationContainer fiber with a
    // navigate() ref. The fiber ref lives on the same renderer as the
    // container itself, so no cross-renderer lookup is needed — we just
    // have to reach the right renderer.
    //
    // GH #72: when the app renders <NavigationContainer> without a ref prop
    // (common in Expo Router and minimalist setups), neither fiber.ref nor
    // fiber.stateNode carry a navigate() function. React Navigation's
    // internal ref from useNavigationContainerRef() lives on the hooks
    // linked list at fiber.memoizedState. Walk that chain too — strict
    // match on { navigate, dispatch, getRootState } avoids picking up
    // unrelated refs in apps with multiple navigation libraries.
    return forEachRootFiber(function(rootFiber) {
      var localFound = null;
      var count = 0;
      var stack = [rootFiber];
      while (stack.length > 0 && !localFound && count < 5000) {
        var fiber = stack.pop();
        if (!fiber) continue;
        count++;
        // GH #597: React Navigation 7 exports the container as a forwardRef
        // wrapper — the fiber.type object has no displayName/name; the real
        // name survives only on type.render.
        var t = fiber.type;
        var name = t && (t.displayName || t.name);
        if (!name && t && t.render) name = t.render.displayName || t.render.name;
        if (name === 'NavigationContainer' || name === 'NavigationContainerInner') {
          var r = fiber.ref;
          if (r && typeof r === 'object' && r.current && typeof r.current.navigate === 'function') {
            localFound = r.current;
            break;
          }
          if (fiber.stateNode && typeof fiber.stateNode.navigate === 'function') {
            localFound = fiber.stateNode;
            break;
          }
          // GH #72: walk the hooks linked list for the internal ref.
          var hook = fiber.memoizedState;
          var hopGuard = 0;
          while (hook && hopGuard < 100) {
            hopGuard++;
            var hms = hook.memoizedState;
            if (hms && hms.current
                && typeof hms.current.navigate === 'function'
                && typeof hms.current.dispatch === 'function'
                && typeof hms.current.getRootState === 'function') {
              localFound = hms.current;
              break;
            }
            hook = hook.next;
          }
          if (localFound) break;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      return localFound;
    });
  }

  function navigateTo(screen, params) {
    var ref = findNavRef();
    // GH #72: error message updated to reflect the wider discovery surface.
    // findNavRef() now checks 3 globals + fiber.ref + fiber.stateNode +
    // fiber.memoizedState hooks chain. If all of those miss, the app is
    // likely on React Navigation < 6.x (no NavigationContainer fiber name)
    // or has wrapped the container in something unrecognized.
    if (!ref) return JSON.stringify({ __agent_error: 'Navigation ref not found. The plugin walks 3 globals (__NAV_REF__, __NAVIGATION_REF__, navigationRef), NavigationContainer fiber.ref + fiber.stateNode, and the useNavigationContainerRef() hooks chain. None matched. If you are on React Navigation 6+, ensure <NavigationContainer> is rendered. As a last resort, expose globalThis.__NAV_REF__ = navigationRef in your app entry.' });

    try {
      var state = ref.getRootState();
      if (!state) return JSON.stringify({ __agent_error: 'No navigation state' });

      if (state.routeNames && state.routeNames.indexOf(screen) !== -1) {
        ref.navigate(screen, params || undefined);
        return JSON.stringify({ navigated: true, screen: screen, method: 'direct' });
      }

      function findPath(navState, target, path) {
        if (!navState) return null;
        var names = navState.routeNames || [];
        if (names.indexOf(target) !== -1) {
          path.push(target);
          return path;
        }
        var routes = navState.routes || [];
        for (var i = 0; i < routes.length; i++) {
          var route = routes[i];
          var childState = route.state;
          if (!childState && navState.routeNames) {
            for (var j = 0; j < navState.routeNames.length; j++) {
              if (navState.routeNames[j] === route.name && route.state) {
                childState = route.state;
                break;
              }
            }
          }
          if (childState) {
            var result = findPath(childState, target, path.concat([route.name]));
            if (result) return result;
          }
        }
        return null;
      }

      var path = findPath(state, screen, []);
      if (path && path.length > 0) {
        var action = { screen: path[path.length - 1], params: params };
        for (var i = path.length - 2; i >= 0; i--) {
          action = { screen: path[i], params: action };
        }
        ref.dispatch({ type: 'NAVIGATE', payload: { name: action.screen, params: action.params } });
        return JSON.stringify({ navigated: true, screen: screen, method: 'nested-dispatch', path: path });
      }

      var tabsRoute = state.routes && state.routes.find(function(r) { return r.name === 'Tabs'; });
      var tabState = tabsRoute && tabsRoute.state;
      var tabNames = tabState && tabState.routeNames ? tabState.routeNames : [];
      for (var t = 0; t < tabNames.length; t++) {
        try {
          var beforeState = JSON.stringify(ref.getRootState());
          ref.navigate(tabNames[t], { screen: screen, params: params });
          var afterState = ref.getRootState();
          var activeRoute = afterState;
          var navDepth = 0;
          while (activeRoute.routes && activeRoute.index !== undefined && navDepth++ < 50) {
            activeRoute = activeRoute.routes[activeRoute.index].state || activeRoute.routes[activeRoute.index];
          }
          var activeName = activeRoute.name || (activeRoute.routes && activeRoute.routes[activeRoute.index] && activeRoute.routes[activeRoute.index].name);
          if (activeName === screen) {
            return JSON.stringify({ navigated: true, screen: screen, method: 'tab-scan', tab: tabNames[t] });
          }
        } catch(e2) { /* try next tab */ }
      }

      ref.navigate(screen, params || undefined);
      var afterFallback = ref.getRootState();

      // CDP-009: previously the fallback used a recursive checkRoute that
      // walked ALL routes including inactive tab branches and parent
      // history. A target sitting in an inactive tab's stack would
      // satisfy found=true and the helper would report success, but the
      // requested screen was NOT the visible leaf. Now we verify the
      // deepest ACTIVE route matches the target.
      function getDeepestActive(s) {
        if (!s) return null;
        if (s.routes && typeof s.index === 'number' && s.routes[s.index]) {
          var route = s.routes[s.index];
          if (route.state) return getDeepestActive(route.state);
          return route.name || null;
        }
        return s.name || null;
      }
      var deepestActive = getDeepestActive(afterFallback);
      if (deepestActive === screen) {
        return JSON.stringify({ navigated: true, screen: screen, method: 'fallback-navigate', deepest_active: deepestActive });
      }

      // Target may exist somewhere in the tree (inactive tab or parent of
      // current) — we report this as a failure but with metadata so the
      // caller can distinguish "not found at all" from "exists but not
      // the active leaf".
      var existsInTree = false;
      function checkRoute(rs) {
        if (!rs) return;
        if (rs.name === screen) { existsInTree = true; return; }
        if (rs.routes) {
          for (var ri = 0; ri < rs.routes.length; ri++) {
            checkRoute(rs.routes[ri]);
            if (rs.routes[ri].state) checkRoute(rs.routes[ri].state);
          }
        }
      }
      checkRoute(afterFallback);
      if (existsInTree) {
        return JSON.stringify({
          __agent_error: 'Navigate failed: screen "' + screen + '" exists in the navigation tree but is not the active leaf (currently: "' + deepestActive + '"). Likely covered by a stacked modal or parked in an inactive tab history.',
          arrived: false,
          deepest_active: deepestActive,
          arrived_via: 'inactive-or-covered',
        });
      }
      return JSON.stringify({ __agent_error: 'Navigate failed: screen "' + screen + '" not found in any navigator after dispatch. Check screen name spelling and that it is registered in a navigator.' });

    } catch(e) {
      return JSON.stringify({ __agent_error: 'Navigation failed: ' + (e && e.message || String(e)) });
    }
  }

  function getComponentState(testID) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var targetFiber = null;

    function findByTestID(fiber) {
      if (!fiber || targetFiber) return;
      var props = fiber.memoizedProps;
      if (props && (props.testID === testID || props.nativeID === testID)) {
        targetFiber = fiber;
        return;
      }
      var child = fiber.child;
      while (child) {
        findByTestID(child);
        child = child.sibling;
      }
    }

    // B145: search every renderer for the testID. Closure-mutated target-
    // Fiber lets the forEachRootFiber helper short-circuit as soon as any
    // renderer yields the match.
    forEachRootFiber(function(rootFiber) {
      findByTestID(rootFiber);
      return targetFiber;
    });
    if (!targetFiber) return JSON.stringify({ __agent_error: 'Component not found: ' + testID });

    var compName = targetFiber.type && (targetFiber.type.displayName || targetFiber.type.name) || null;

    var hooks = [];
    var hookState = targetFiber.memoizedState;
    var limit = 20;
    while (hookState && limit-- > 0) {
      var hs;
      try { hs = hookState.memoizedState; }
      catch(e) { hooks.push('[HookAccessError]'); hookState = hookState.next; continue; }

      if (typeof hs === 'function') {
        hooks.push('[Function]');
      } else if (typeof hs === 'object' && hs !== null) {
        try {
          if (hs.current !== undefined) {
            hooks.push({ ref: hs.current !== null ? typeof hs.current : null });
          } else if (hs._formValues && hs._formState) {
            hooks.push({
              __type: 'react-hook-form',
              values: sanitizeForSerialization(hs._formValues),
              errors: sanitizeForSerialization(hs._formState.errors),
              isDirty: hs._formState.isDirty,
              isValid: hs._formState.isValid,
              isSubmitting: hs._formState.isSubmitting
            });
          } else {
            // Use sanitizer directly to handle getters that throw (useNavigation etc.)
            hooks.push(sanitizeForSerialization(hs));
          }
        } catch(e) {
          hooks.push('[HookSerializeError:' + (e && e.message && e.message.slice(0, 60) || 'unknown') + ']');
        }
      } else {
        hooks.push(hs);
      }
      try { hookState = hookState.next; }
      catch(e) { break; }
    }

    var propsObj = {};
    if (targetFiber.memoizedProps) {
      var pkeys;
      try { pkeys = Object.keys(targetFiber.memoizedProps); }
      catch(e) { pkeys = []; }
      for (var i = 0; i < pkeys.length; i++) {
        try {
          var v = targetFiber.memoizedProps[pkeys[i]];
          propsObj[pkeys[i]] = typeof v === 'function' ? '[Function]' : sanitizeForSerialization(v);
        } catch(e) {
          propsObj[pkeys[i]] = '[PropAccessError]';
        }
      }
    }

    return safeStringify({
      component: compName,
      testID: testID,
      props: propsObj,
      hooks: hooks
    }, 100000);
  }

  function hostIsFocused(fiber) {
    try {
      var sn = fiber && fiber.stateNode;
      if (!sn) return false;
      if (typeof sn.isFocused !== 'function' && sn.canonical && sn.canonical.publicInstance) {
        sn = sn.canonical.publicInstance;
      }
      return typeof sn.isFocused === 'function' && sn.isFocused() === true;
    } catch (_) {
      return false;
    }
  }

  function readInputValue(testID, options) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var resolution = resolveTypeTextTarget({ testID: testID, omitValue: true });
    if (resolution.error) return JSON.stringify({ __agent_error: resolution.error });
    if (!resolution.binding) return JSON.stringify({ value: null, controlled: false, focused: false });
    var props = resolution.binding.candidateFiber.memoizedProps || {};
    var focused = hostIsFocused(resolution.binding.candidateFiber);
    if (options && options.focusOnly) return JSON.stringify({ value: null, controlled: false, focused: focused });
    if (options && (options.privateValue || (options.protectSecure && props.secureTextEntry === true))) {
      return JSON.stringify({ value: null, controlled: false, focused: focused, privateValue: true });
    }
    if (typeof props.value === 'string') {
      return JSON.stringify({ value: props.value, controlled: true, focused: focused });
    }
    return JSON.stringify({ value: null, controlled: false, focused: focused });
  }

  // Task 8 — bounded fiber.return ancestor walk producing the bundle's
  // anchor trail. Mirrors the setFieldValue ancestor walk (cap + .return
  // chain) at the ANCESTOR_DEPTH_CAP loop, but records nearest-first
  // {testID, text, relation, depth, provenance} for any ancestor that
  // carries a testID/nativeID OR an explicit accessibility label. Provenance
  // is "authored-testID" when the ancestor has testID/nativeID, else "text"
  // (from __ariaLabel — aria-label / accessibilityLabel / labelledBy only,
  // NOT recursive child text, so bare host Text nodes are skipped). Bare
  // wrapper Views with no anchor signal are skipped automatically.
  function __collectAnchors(fiber) {
    var ANCHOR_DEPTH_CAP = 8;
    var anchors = [];
    if (!fiber) return anchors;
    var ancestor = fiber.return;
    var depth = 1;
    while (ancestor && depth <= ANCHOR_DEPTH_CAP) {
      var aProps = ancestor.memoizedProps;
      var testID = aProps && typeof aProps === 'object'
        ? (aProps.testID || aProps.nativeID)
        : undefined;
      var name;
      try { name = __ariaLabel(ancestor); } catch (_) { name = undefined; }
      if (testID || (name && name.length > 0)) {
        var entry = { relation: 'childOf', depth: depth };
        if (testID) {
          entry.testID = String(testID);
          entry.provenance = 'authored-testID';
        } else {
          entry.text = String(name);
          entry.provenance = 'text';
        }
        anchors.push(entry);
      }
      ancestor = ancestor.return;
      depth++;
    }
    return anchors;
  }

  // Task 7 — fiber-returning twin of resolveLadder. resolveLadder serializes
  // to JSON (no live fiber escapes); interact() needs the fiber itself to
  // press, so it re-resolves here under the SAME predicates and returns the
  // single match (or null when 0/>1 — interact() has already surfaced the
  // JSON error before calling this). Uses the internal hostKind() (the
  // public surface name is __hostKind, but inside the IIFE the function is
  // hostKind — same as __role's own call site).
  // matchDeepestOnly (RNTL parity; found by live-device testing): a real RN
  // element renders as a COMPOSITE fiber (Text/TextInput) AND its child HOST
  // fiber (RCTText/RCTSinglelineTextInputView), both of which pass
  // hostKind/byText/byPlaceholder — so every element would match twice and
  // fail-close as Ambiguous on-device. Drop any match that is an ancestor (via
  // .return) of another match, keeping the deepest. Genuinely-distinct siblings
  // are NOT collapsed (they stay legitimately Ambiguous).
  // Collapse only COMPOSITE+HOST duplicates of the SAME element — NOT arbitrary
  // ancestor/descendant matches. A real RN element is a composite fiber
  // (Text/TextInput/Pressable, object type) plus its host primitive
  // (RCTText/RCTSinglelineTextInputView/RCTView, string type); both can satisfy
  // the same selector. But two DISTINCT nested components (e.g. an outer card
  // button and an inner button both named "Settings") must stay AMBIGUOUS, not
  // silently collapse to the inner one (Codex review). Rule: for each HOST
  // match B, drop its NEAREST matching ancestor iff that ancestor is a composite
  // — i.e. B's own wrapper. A host-ancestor (distinct nested host) or a composite
  // with no host match below it is preserved, so real nested matches stay
  // ambiguous.
  function __deepestOnly(arr) {
    if (arr.length < 2) return arr;
    function tid(f) { var p = f.memoizedProps; return (p && (p.testID || p.nativeID)) || null; }
    var inSet = new WeakSet();
    for (var i = 0; i < arr.length; i++) inSet.add(arr[i]);
    var drop = new WeakSet();
    for (var j = 0; j < arr.length; j++) {
      var b = arr[j];
      var bHost = typeof b.type === 'string';
      var bTid = tid(b);
      var p = b.return;
      var guard = 0;
      while (p && guard++ < 10000) {
        if (inSet.has(p)) {
          // Nearest matching ancestor A of B. Drop A only when A and B are the
          // SAME element: (1) A is B's composite wrapper (A composite, B host),
          // or (2) A and B share the same testID/nativeID (one element whose id
          // propagated across nested fibers, e.g. a tab button). A distinct
          // nested match — a host ancestor, or a different id — is preserved so
          // real nested matches stay Ambiguous (Codex review).
          var aComposite = typeof p.type !== 'string';
          if ((aComposite && bHost) || (bTid && tid(p) === bTid)) drop.add(p);
          break;
        }
        p = p.return;
      }
    }
    var kept = [];
    for (var k = 0; k < arr.length; k++) {
      if (!drop.has(arr[k])) kept.push(arr[k]);
    }
    return kept;
  }

  // RNTL isAccessibilityElement: byRole only matches true accessibility
  // elements. A plain View with a role prop but accessible undefined is NOT
  // one — only Text/TextInput/Switch (and Image with alt) qualify by default;
  // anything else must opt in with accessible={true}. (Codex review.)
  function __isA11yElement(fiber) {
    if (!fiber) return false;
    var props = fiber.memoizedProps;
    var hk = hostKind(fiber);
    if (hk === 'image' && props && props.alt !== undefined) return true;
    if (props && props.accessible !== undefined) return props.accessible === true;
    return hk === 'text' || hk === 'textinput' || hk === 'switch';
  }

  function __resolveLadderFiber(spec) {
    var wantRole = typeof spec.role === 'string' ? normalizeRole(spec.role) : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function isCand(fiber) {
      if (typeof spec.testID === 'string') {
        var tpi = fiber.memoizedProps;
        return !!tpi && (tpi.testID === spec.testID || tpi.nativeID === spec.testID);
      }
      if (wantRole !== null) {
        // byRole only matches true accessibility elements (RNTL
        // isAccessibilityElement): excludes a plain View with a role prop but
        // accessible undefined, and honors accessible={false}. (Codex review.)
        if (!__isA11yElement(fiber)) return false;
        if (__role(fiber) !== wantRole) return false;
        if (wantName === null) return true;
        var an = __accessibleName(fiber);
        return an != null && __match(an, { value: wantName, exact: exact });
      }
      if (wantText !== null) {
        if (hostKind(fiber) !== 'text') return false;
        var tn = __refTextContent(fiber);
        return !!tn && __match(tn, { value: wantText, exact: exact });
      }
      if (wantPlaceholder !== null) {
        if (hostKind(fiber) !== 'textinput') return false;
        var p = fiber.memoizedProps;
        var ph = p && typeof p.placeholder === 'string' ? p.placeholder : null;
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var out = [];
    var n = 0;
    var lfTrunc = false;
    var lfRoots = 0;
    forEachRootFiber(function () { lfRoots++; return null; });
    var lfBudget = Math.min(40000, 8000 * Math.max(1, lfRoots));
    var lfStart = Date.now();
    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          n++;
          if (n > lfBudget || (Date.now() - lfStart) > 3000) { lfTrunc = true; return; }
          if (isCand(current) && (includeHidden || !__hidden(current))) out.push(current);
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null;
    });
    if (lfTrunc) return null; // fail closed — never press a partial-walk pick
    var dedupOut = __deepestOnly(out);
    return dedupOut.length === 1 ? dedupOut[0] : null;
  }

  // Task 7 — declarative ladder resolver. Composes the pure helpers
  // (__match/__role/__accessibleName/__hidden/hostKind) into byRole,
  // byText and byPlaceholder predicates. COLLECT ALL matches across every
  // renderer (no early return) so duplicate targets surface as Ambiguous
  // rather than a silent pick — mirrors interact()'s label-tier ambiguous
  // shape (:1259-1266). bundle.bounds is null in Phase 1 (no in-page
  // measure primitive yet).
  function resolveLadder(specJson) {
    var spec;
    try {
      spec = typeof specJson === 'string' ? JSON.parse(specJson) : (specJson || {});
    } catch (e) {
      return JSON.stringify({ found: false, error: 'Invalid spec JSON' });
    }

    var wantRole = typeof spec.role === 'string' ? normalizeRole(spec.role) : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function nameMatches(fiber) {
      if (wantName === null) return true;
      var an = __accessibleName(fiber);
      if (an === undefined || an === null) return false;
      return __match(an, { value: wantName, exact: exact });
    }

    // byText: a host Text node whose own visible TEXT CONTENT __match-es — NOT
    // its accessible name (which gives accessibilityLabel/aria-label precedence
    // over the rendered text; Codex review). Use __refTextContent (the
    // getTextContent port); accessible names stay for byRole/name.
    function textContentMatches(fiber) {
      var tc = __refTextContent(fiber);
      if (!tc) return false;
      return __match(tc, { value: wantText, exact: exact });
    }

    function placeholderOf(fiber) {
      var p = fiber && fiber.memoizedProps;
      return p && typeof p.placeholder === 'string' ? p.placeholder : null;
    }

    function isCandidate(fiber) {
      if (typeof spec.testID === 'string') {
        var tpc = fiber.memoizedProps;
        return !!tpc && (tpc.testID === spec.testID || tpc.nativeID === spec.testID);
      }
      if (wantRole !== null) {
        // byRole only matches true accessibility elements (RNTL
        // isAccessibilityElement): excludes a plain View with a role prop but
        // accessible undefined, and honors accessible={false}. (Codex review.)
        if (!__isA11yElement(fiber)) return false;
        if (__role(fiber) !== wantRole) return false;
        return nameMatches(fiber);
      }
      if (wantText !== null) {
        if (hostKind(fiber) !== 'text') return false;
        return textContentMatches(fiber);
      }
      if (wantPlaceholder !== null) {
        if (hostKind(fiber) !== 'textinput') return false;
        var ph = placeholderOf(fiber);
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var matched = [];
    var visitCount = 0;
    var ladderTrunc = false;
    // Budget scales with renderer count + a wall-clock guard (mirrors the legacy
    // findFiber path). On trip we FAIL CLOSED instead of evaluating a partial
    // match set (Codex review: a duplicate past the cap could otherwise leave
    // matched.length===1 and silently press the wrong element).
    var ladderRoots = 0;
    forEachRootFiber(function () { ladderRoots++; return null; });
    var ladderBudget = Math.min(40000, 8000 * Math.max(1, ladderRoots));
    var ladderStart = Date.now();

    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          visitCount++;
          if (visitCount > ladderBudget || (Date.now() - ladderStart) > 3000) {
            ladderTrunc = true;
            return;
          }
          if (isCandidate(current)) {
            if (includeHidden || !__hidden(current)) matched.push(current);
          }
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null; // collect-all — never short-circuit
    });

    if (ladderTrunc) {
      return JSON.stringify({
        found: false,
        error: 'Resolution truncated',
        truncated: true,
        scanned: visitCount,
        hint: 'Too many fibers scanned before a unique match — scope with a more specific selector or a container, or add a testID.'
      });
    }

    // matchDeepestOnly: collapse composite+host fiber pairs (see __deepestOnly)
    // so one on-device element is one match, not a false Ambiguous.
    matched = __deepestOnly(matched);

    function describe(fiber) {
      var props = fiber.memoizedProps || {};
      var dt = (fiber.type && (typeof fiber.type === 'string'
        ? fiber.type
        : (fiber.type.displayName || fiber.type.name))) || 'Unknown';
      return {
        component: dt,
        testID: props.testID,
        role: __role(fiber),
        accessibleName: __accessibleName(fiber),
      };
    }

    function hintFor() {
      var bits = [];
      if (wantRole !== null) bits.push('role="' + wantRole + '"');
      if (wantName !== null) bits.push('name="' + wantName + '"');
      if (wantText !== null) bits.push('text="' + wantText + '"');
      if (wantPlaceholder !== null) bits.push('placeholder="' + wantPlaceholder + '"');
      return bits.join(' ');
    }

    if (matched.length === 0) {
      return JSON.stringify({
        found: false,
        error: 'Component not found',
        hint: 'No accessible component matched ' + hintFor() +
          (includeHidden ? '' : ' (hidden elements excluded — pass includeHidden:true to include them)') +
          '. Use cdp_component_tree to verify it is mounted, or pass a testID.'
      });
    }

    if (matched.length > 1) {
      var descriptors = [];
      for (var di = 0; di < matched.length && di < 10; di++) descriptors.push(describe(matched[di]));
      return JSON.stringify({
        found: false,
        error: 'Ambiguous component match',
        count: matched.length,
        matches: descriptors,
        hint: 'Add a testID'
      });
    }

    var target = matched[0];
    var tprops = target.memoizedProps || {};
    var bundle = {
      testID: tprops.testID,
      text: hostKind(target) === 'text' ? __refTextContent(target) : undefined,
      accessibleName: __accessibleName(target),
      role: __role(target),
      placeholder: placeholderOf(target) || undefined,
      disabled: (tprops.disabled === true)
        || (tprops['aria-disabled'] === true)
        || !!(tprops.accessibilityState && tprops.accessibilityState.disabled),
      bounds: null,
      anchors: __collectAnchors(target)
    };
    return JSON.stringify({ found: true, bundle: bundle });
  }

  // Port of RNTL getDefaultNormalizer (matches.ts:37-47): trim + collapse
  // whitespace runs to a single space. Does NOT lowercase — case-insensitivity
  // for non-exact string matching lives in __match's compare (RNTL matches.ts:24),
  // NOT here. Kept deliberately separate from norm() (line ~1114) which DOES
  // lowercase for the legacy interact() label tiers.
  function __matchNormalize(v) {
    return String(v).replace(/^\\s+|\\s+$/g, '').replace(/\\s+/g, ' ');
  }

  // Port of RNTL matches() (matches.ts:9-30) collapsed to a single matcher
  // object: {value,exact?} for strings, {regexSource,regexFlags?} for regexes.
  // Returns false on non-string text or malformed matcher. Regex is compiled in
  // try/catch, the global flag is stripped so lastIndex never carries across
  // calls, and the candidate is length-capped to bound catastrophic backtracking.
  var __MATCH_MAX_LEN = 10000;
  function __match(text, matcher) {
    if (typeof text !== 'string') return false;
    if (!matcher || typeof matcher !== 'object') return false;
    var normalizedText = __matchNormalize(text);
    if (normalizedText.length > __MATCH_MAX_LEN) {
      normalizedText = normalizedText.slice(0, __MATCH_MAX_LEN);
    }
    if (typeof matcher.regexSource === 'string') {
      try {
        var flags = (matcher.regexFlags || '').replace(/g/g, '');
        var re = new RegExp(matcher.regexSource, flags);
        re.lastIndex = 0;
        return re.test(normalizedText);
      } catch (_) {
        return false;
      }
    }
    if (typeof matcher.value !== 'string') return false;
    var normalizedMatcher = __matchNormalize(matcher.value);
    if (matcher.exact) {
      return normalizedText === normalizedMatcher;
    }
    return normalizedText.toLowerCase().indexOf(normalizedMatcher.toLowerCase()) >= 0;
  }

  // ── Accessibility role (RNTL getRole + normalizeRole port) ──────────────
  // Port of react-native-testing-library accessibility.ts:117-146. Order:
  // explicit role prop → accessibilityRole (image→img) → host Text → none.
  // Deliberately NOT the digest inferRole (defaults Pressable/Touchable to
  // button); see gh-task3-role.test.js divergence guard.
  function normalizeRole(role) {
    if (role === 'image') return 'img';
    return role;
  }

  function __role(fiber) {
    if (!fiber) return 'none';
    var props = fiber.memoizedProps;
    var explicitRole = props && typeof props === 'object'
      ? (props.role != null ? props.role : props.accessibilityRole)
      : null;
    if (explicitRole) return normalizeRole(String(explicitRole));
    if (hostKind(fiber) === 'text') return 'text';
    return 'none';
  }

  // ── Task 4: accessible-name computation (port of RNTL accessibility.ts:152-318) ──
  // Whitespace normalizer that preserves case (distinct from norm() at the
  // interact() tier matcher which lowercases). Trim + collapse ws runs to one.
  function __anNorm(s) {
    return String(s).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
  }

  // getAriaLabelledByIds: aria-labelledby (string) -> [id]; accessibilityLabelledBy
  // array -> as-is; accessibilityLabelledBy string -> [id]; else [].
  function __ariaLabelledByIds(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    var ariaLabelledBy = props['aria-labelledby'];
    if (typeof ariaLabelledBy === 'string') return [ariaLabelledBy];
    var accLabelledBy = props.accessibilityLabelledBy;
    if (Array.isArray(accLabelledBy)) return accLabelledBy;
    if (typeof accLabelledBy === 'string') return [accLabelledBy];
    return [];
  }

  // Find the first fiber in ANY root whose memoizedProps.nativeID === id.
  function __findByNativeID(id) {
    return forEachRootFiber(function(rootFiber) {
      var stack = [rootFiber];
      var guard = 0;
      while (stack.length) {
        if (++guard > 20000) return null;
        var f = stack.pop();
        if (!f) continue;
        if (f.memoizedProps && f.memoizedProps.nativeID === id) return f;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      return null;
    });
  }

  // DEVIATION from RNTL draft (port of getTextContent, NOT computeAccessibleName):
  // concatenate the referenced node's descendant host-text strings. A text node
  // carries its raw string as memoizedProps (harness) or has tag 6 (live fiber).
  // labelledBy refs resolve to THIS, never to __accessibleName — so a malformed
  // labelledBy cycle (A->B->A) cannot drive infinite recursion. The visit cap is
  // defense-in-depth against pathological / self-referential trees.
  function __refTextContent(fiber) {
    if (!fiber) return '';
    var parts = [];
    var visited = 0;
    (function collect(node, depth) {
      if (!node || depth > 40 || visited > 20000) return;
      visited++;
      if (typeof node.memoizedProps === 'string') {
        if (node.memoizedProps) parts.push(node.memoizedProps);
        return;
      }
      if (node.tag === 6 && typeof node.memoizedProps === 'string') {
        if (node.memoizedProps) parts.push(node.memoizedProps);
        return;
      }
      var child = node.child;
      while (child) { collect(child, depth + 1); child = child.sibling; }
    })(fiber, 0);
    return __anNorm(parts.join(' '));
  }

  // computeAriaLabel: labelledBy refs (resolved to TEXT CONTENT — see
  // __refTextContent) win; then explicit aria-label/accessibilityLabel; then
  // host image alt. A ref resolving to empty text is filtered out of labelTexts
  // (matches RNTL filtering undefined), so it falls through to the label branch.
  function __ariaLabel(fiber) {
    var ids = __ariaLabelledByIds(fiber);
    if (ids.length > 0) {
      var labelTexts = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = __findByNativeID(ids[i]);
        if (ref) {
          var refText = __refTextContent(ref);
          if (refText) labelTexts.push(refText);
        }
      }
      if (labelTexts.length > 0) {
        return __anNorm(labelTexts.join(' '));
      }
    }

    var props = (fiber && fiber.memoizedProps) || {};
    var explicit = props['aria-label'];
    if (explicit === undefined || explicit === null) explicit = props.accessibilityLabel;
    if (explicit) return explicit;

    if (hostKind(fiber) === 'image' && props.alt) return props.alt;

    return undefined;
  }

  // joinAccessibleNameParts: inline host-text neighbours join with '' else ' '.
  function __joinNameParts(parts, inline) {
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i === 0) { out = parts[i].text; continue; }
      var prev = parts[i - 1];
      var sep = (inline && prev.isInlineText && parts[i].isInlineText) ? '' : ' ';
      out = out + sep + parts[i].text;
    }
    return out;
  }

  // computeAccessibleName: aria-label first; then host textinput placeholder
  // (root only); then recurse children, joining inline host-text with ''. The
  // child-name recursion below (correct RNTL behavior) stays — only labelledBy
  // ref resolution uses text content (see __ariaLabel / __refTextContent).
  function __accessibleName(fiber, root) {
    if (!fiber) return undefined;
    var label = __ariaLabel(fiber);
    if (label) return label;

    var props = fiber.memoizedProps || {};
    if (hostKind(fiber) === 'textinput' && props.placeholder && root !== false) {
      return props.placeholder;
    }

    var parts = [];
    var child = fiber.child;
    while (child) {
      // A text node's memoizedProps is the raw string (harness / live tag-6 fiber).
      if (typeof child.memoizedProps === 'string') {
        if (child.memoizedProps) {
          parts.push({ text: child.memoizedProps, isInlineText: true });
        }
      } else {
        var childLabel = __accessibleName(child, false);
        if (childLabel) {
          parts.push({ text: childLabel, isInlineText: hostKind(child) === 'text' });
        }
      }
      child = child.sibling;
    }

    var joined = __joinNameParts(parts, hostKind(fiber) === 'text');
    return joined ? joined : undefined;
  }

  var MISSING_STYLE_VALUE = {};
  function styleValue(style, key) {
    if (style == null) return MISSING_STYLE_VALUE;
    try {
      if (Array.isArray(style)) {
        for (var i = style.length - 1; i >= 0; i--) {
          var v = styleValue(style[i], key);
          if (v !== MISSING_STYLE_VALUE) return v;
        }
        return MISSING_STYLE_VALUE;
      }
      if (typeof style === 'object' && key in style) return style[key];
    } catch (_) {}
    return MISSING_STYLE_VALUE;
  }

  // True if \`fiber\` itself is an inaccessible-subtree root.
  function isSubtreeInaccessible(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    if (props['aria-hidden']) return true;
    if (props.accessibilityElementsHidden) return true;
    if (props.importantForAccessibility === 'no-hide-descendants') return true;

    if (styleValue(props.style, 'display') === 'none') return true;

    // iOS: a host sibling marked aria-modal / accessibilityViewIsModal hides
    // this subtree. Siblings = children of fiber.return other than fiber.
    var parent = fiber && fiber.return;
    if (parent && parent.child) {
      for (var sib = parent.child; sib; sib = sib.sibling) {
        if (sib === fiber) continue;
        var sp = sib.memoizedProps;
        if (sp && (sp['aria-modal'] || sp.accessibilityViewIsModal)) return true;
      }
    }
    return false;
  }

  function __hidden(fiber) {
    if (fiber == null) return true;
    var current = fiber;
    var guard = 0;
    while (current && guard < 1000) {
      if (isSubtreeInaccessible(current)) return true;
      current = current.return;
      guard++;
    }
    return false;
  }

  var ELIGIBILITY_CLEAR = { blocked: false, blockedBy: null, hidden: false };

  function eligibilityPointerEvents(fiber) {
    var props = fiber.memoizedProps;
    if (!props) return null;
    if (typeof props.pointerEvents === 'string') return props.pointerEvents;
    if (props.style == null) return null;
    var pe = styleValue(props.style, 'pointerEvents');
    return typeof pe === 'string' ? pe : null;
  }

  // Only host fibers are views, and only a view decides pointerEvents/hidden in hitTest.
  function eligibilityDescend(inherited, fiber) {
    if (!fiber || fiber.tag !== 5) return inherited;
    var blocked = inherited.blocked;
    var blockedBy = inherited.blockedBy;
    var hidden = inherited.hidden;
    if (!blocked) {
      var pointerEvents = eligibilityPointerEvents(fiber);
      if (pointerEvents === 'none' || pointerEvents === 'box-only') {
        blocked = true;
        blockedBy = pointerEvents;
      }
    }
    if (!hidden && isSubtreeInaccessible(fiber)) hidden = true;
    if (blocked === inherited.blocked && hidden === inherited.hidden) return inherited;
    return { blocked: blocked, blockedBy: blockedBy, hidden: hidden };
  }

  function eligibilitySameSelector(fiber, selector) {
    var props = fiber && fiber.memoizedProps;
    if (!props || selector === undefined || selector === null) return false;
    return props.testID === selector || props.nativeID === selector;
  }

  // The logical element is evaluated at the deepest host reached by a downward
  // single-child chain of same-selector fibers.
  function eligibilityEvaluate(fiber, inherited, selector) {
    var state = inherited || ELIGIBILITY_CLEAR;
    var host = fiber && fiber.tag === 5 ? fiber : null;
    var hostInherited = state;
    var node = fiber;
    var steps = 0;
    while (node && steps < 1000) {
      var child = node.child;
      if (!child || child.sibling || !eligibilitySameSelector(child, selector)) break;
      state = eligibilityDescend(state, node);
      node = child;
      if (node.tag === 5) {
        host = node;
        hostInherited = state;
      }
      steps++;
    }
    return { host: host, inherited: hostInherited };
  }

  function eligibilityDisabled(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    return props.disabled === true
      || props.editable === false
      || (props.accessibilityState && props.accessibilityState.disabled === true);
  }

  function eligibilityHiddenVerdict(fiber, inherited, selector) {
    if (!fiber) {
      return { eligible: false, error: 'Component eligibility could not be proven', reason: 'fiber unavailable' };
    }
    var evaluated = eligibilityEvaluate(fiber, inherited, selector);
    if (evaluated.inherited.hidden || (evaluated.host && isSubtreeInaccessible(evaluated.host))) {
      return { eligible: false, error: 'Component is hidden', reason: 'hidden exact-ID subtree' };
    }
    return { eligible: true, evaluated: evaluated };
  }

  function eligibilityVerdict(fiber, inherited, selector) {
    var verdict = eligibilityHiddenVerdict(fiber, inherited, selector);
    if (!verdict.eligible) return verdict;
    var evaluated = verdict.evaluated;
    if (evaluated.inherited.blocked) {
      return { eligible: false, error: 'Component is not user-interactable beneath pointerEvents="' + evaluated.inherited.blockedBy + '"', reason: 'exact-ID fiber is beneath pointerEvents="' + evaluated.inherited.blockedBy + '"' };
    }
    if (evaluated.host) {
      var pointerEvents = eligibilityPointerEvents(evaluated.host);
      if (pointerEvents === 'none' || pointerEvents === 'box-none') {
        return { eligible: false, error: 'Component is not user-interactable with pointerEvents="' + pointerEvents + '"', reason: 'exact-ID fiber has pointerEvents="' + pointerEvents + '"' };
      }
    }
    return { eligible: true };
  }

  // React return chains may thread through either half of a fiber/alternate pair.
  function sameFiber(a, b) {
    return !!a && !!b && (a === b || a.alternate === b || b.alternate === a);
  }

  function isTestIdFrontmost(testID) {
    if (typeof testID !== 'string' || !testID) {
      return JSON.stringify({ visible: false, reason: 'testID is required' });
    }
    var matches = [];
    var modals = [];
    var scanned = 0;
    var truncated = false;
    forEachRootFiber(function(rootFiber) {
      var stack = [rootFiber];
      while (stack.length) {
        if (++scanned > 40000) { truncated = true; return true; }
        var fiber = stack.pop();
        if (!fiber) continue;
        var props = fiber.memoizedProps || {};
        if (props.testID === testID || props.nativeID === testID) matches.push(fiber);
        if (
          props.visible !== false &&
          !__hidden(fiber) &&
          (props['aria-modal'] || props.accessibilityViewIsModal || hostKind(fiber) === 'modal')
        ) modals.push(fiber);
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      return null;
    });
    if (truncated) {
      return JSON.stringify({
        visible: false,
        reason: 'frontmost testID scan exceeded its bounded React-tree budget',
        code: 'ASSERTION_FAILED',
        truncated: true
      });
    }
    var coverage = rootScanCoverage();
    if (coverage.reasons.length > 0) {
      return JSON.stringify({
        visible: false,
        code: 'ASSERTION_FAILED',
        reason: 'frontmost proof cannot cover every mounted renderer',
        coverage: coverage
      });
    }
    function containsFiber(ancestor, candidate) {
      var current = candidate;
      var guard = 0;
      while (current && guard++ < 1000) {
        if (sameFiber(current, ancestor)) return true;
        current = current.return;
      }
      return false;
    }
    var logicalMatches = [];
    for (var matchIndex = 0; matchIndex < matches.length; matchIndex++) {
      var sameLineage = false;
      for (var logicalIndex = 0; logicalIndex < logicalMatches.length; logicalIndex++) {
        if (
          containsFiber(matches[matchIndex], logicalMatches[logicalIndex]) ||
          containsFiber(logicalMatches[logicalIndex], matches[matchIndex])
        ) {
          sameLineage = true;
          break;
        }
      }
      if (!sameLineage) logicalMatches.push(matches[matchIndex]);
    }
    if (logicalMatches.length !== 1) {
      return JSON.stringify({
        visible: false,
        reason: logicalMatches.length === 0
          ? 'testID is not mounted'
          : 'testID is ambiguous across mounted React trees',
        matchCount: logicalMatches.length
      });
    }
    var target = logicalMatches[0];
    var targetProps = target.memoizedProps || {};
    var targetAccessibilityState = targetProps.accessibilityState || {};
    var targetDisabled = targetProps.disabled === true || targetAccessibilityState.disabled === true;
    if (__hidden(target)) {
      return JSON.stringify({
        visible: false,
        reason: 'testID is mounted in a hidden subtree',
        matchCount: 1
      });
    }

    var targetPointerEvents = targetProps.pointerEvents;
    if (targetPointerEvents === 'none' || targetPointerEvents === 'box-none') {
      return JSON.stringify({
        visible: false,
        reason: 'testID target is not user-interactable with pointerEvents="' + targetPointerEvents + '"',
        code: 'INTERACTION_NOT_ACTUATED',
        matchCount: 1
      });
    }

    var pointerAncestor = target.return;
    var pointerDepth = 0;
    while (pointerAncestor) {
      if (++pointerDepth > 1000) {
        return JSON.stringify({
          visible: false,
          reason: 'pointer-event ancestor proof exceeded its bounded React-tree budget',
          code: 'ASSERTION_FAILED',
          matchCount: 1
        });
      }
      var pointerProps = pointerAncestor.memoizedProps || {};
      if (pointerProps.pointerEvents === 'none' || pointerProps.pointerEvents === 'box-only') {
        return JSON.stringify({
          visible: false,
          reason: 'testID is not user-interactable beneath pointerEvents="' + pointerProps.pointerEvents + '"',
          code: 'INTERACTION_NOT_ACTUATED',
          matchCount: 1
        });
      }
      pointerAncestor = pointerAncestor.return;
    }

    if (modals.length > 0) {
      var containingModalCount = 0;
      for (var mi = 0; mi < modals.length; mi++) {
        if (containsFiber(modals[mi], target)) containingModalCount++;
      }
      if (containingModalCount === 0) {
        return JSON.stringify({
          visible: false,
          reason: 'testID is mounted behind the active modal React subtree',
          matchCount: 1
        });
      }
      if (containingModalCount !== modals.length) {
        return JSON.stringify({
          visible: false,
          reason: 'frontmost modal ordering cannot be proven across visible modal subtrees',
          code: 'ASSERTION_FAILED',
          matchCount: 1,
          modalCount: modals.length
        });
      }
    }

    var navRaw = getNavState();
    var nav;
    try { nav = JSON.parse(navRaw); }
    catch(e) {
      return JSON.stringify({
        visible: false,
        reason: 'navigation state is unreadable',
        code: 'ASSERTION_FAILED',
        matchCount: 1
      });
    }
    if (!nav || nav.error) {
      return JSON.stringify({
        visible: false,
        reason: 'frontmost route cannot be proven from navigation state',
        code: 'ASSERTION_FAILED',
        matchCount: 1
      });
    }
    function activeNavigationChain(node) {
      var current = node;
      var routeNames = [];
      var guard = 0;
      while (current && guard++ < 100) {
        if (
          typeof current.routeName === 'string' &&
          routeNames.indexOf(current.routeName) === -1
        ) routeNames.push(current.routeName);
        if (current.nested) { current = current.nested; continue; }
        if (Array.isArray(current.routes) && current.routes.length > 0) {
          var index = typeof current.index === 'number' ? current.index : current.routes.length - 1;
          if (index < 0) index = 0;
          if (index >= current.routes.length) index = current.routes.length - 1;
          var activeEntry = current.routes[index];
          if (
            activeEntry &&
            typeof activeEntry.name === 'string' &&
            routeNames.indexOf(activeEntry.name) === -1
          ) routeNames.push(activeEntry.name);
          if (activeEntry && activeEntry.state) { current = activeEntry.state; continue; }
        }
        break;
      }
      return routeNames;
    }
    var activeRoutes = activeNavigationChain(nav);
    var activeRoute = activeRoutes.length > 0 ? activeRoutes[activeRoutes.length - 1] : null;
    if (typeof activeRoute !== 'string' || !activeRoute) {
      return JSON.stringify({
        visible: false,
        reason: 'active route is unavailable',
        code: 'ASSERTION_FAILED',
        matchCount: 1
      });
    }
    function readRouteRecord(route) {
      if (
        !route || typeof route !== 'object' || Array.isArray(route)
        || typeof route.key !== 'string' || !route.key
        || typeof route.name !== 'string' || !route.name
      ) return null;
      return route;
    }
    function readBoundRoute(navigation, route) {
      if (
        !navigation || typeof navigation !== 'object'
        || typeof navigation.isFocused !== 'function'
      ) throw new Error('invalid navigator');
      var readState = 'getState' in navigation
        ? navigation.getState
        : navigation.dangerouslyGetState;
      if (typeof readState !== 'function') throw new Error('invalid navigator');
      var state = readState.call(navigation);
      validateRouteMembership(state, route);
      var focused = navigation.isFocused();
      if (
        typeof focused !== 'boolean'
        || (focused && state.routes[state.index].key !== route.key)
      ) throw new Error('invalid route focus');
      return { state: state, focused: focused };
    }
    function validateRouteMembership(state, route) {
      if (
        !state || typeof state !== 'object' || Array.isArray(state)
        || !Array.isArray(state.routes) || state.routes.length === 0
        || !Number.isInteger(state.index)
        || state.index < 0 || state.index >= state.routes.length
      ) throw new Error('invalid navigator state');
      var matches = 0;
      for (var routeIndex = 0; routeIndex < state.routes.length; routeIndex++) {
        var known = readRouteRecord(state.routes[routeIndex]);
        if (!known) throw new Error('invalid navigator route');
        if (known.key === route.key) {
          if (known.name !== route.name) throw new Error('inconsistent navigator route');
          matches++;
        }
      }
      if (matches !== 1) throw new Error('ambiguous navigator membership');
    }
    function sameRoute(left, right) {
      return !!readRouteRecord(left) && !!readRouteRecord(right)
        && left.key === right.key && left.name === right.name;
    }
    function sameRouteState(left, right) {
      if (
        typeof left.key !== 'string' || !left.key || left.key !== right.key
        || left.index !== right.index || left.routes.length !== right.routes.length
      ) return false;
      for (var index = 0; index < left.routes.length; index++) {
        if (!sameRoute(left.routes[index], right.routes[index])) return false;
      }
      return true;
    }
    function hasOnlyProps(props, keys) {
      var ownKeys = Object.keys(props);
      return ownKeys.length === keys.length && keys.every(function(key) {
        return Object.prototype.hasOwnProperty.call(props, key);
      });
    }
    function adjacentNavigationContext(ancestry, from, step) {
      for (var index = from + step; index >= 0 && index < ancestry.length && ancestry[index].tag === 10; index += step) {
        var value = ancestry[index].memoizedProps && ancestry[index].memoizedProps.value;
        if (
          value && typeof value === 'object' && typeof value.isFocused === 'function'
          && (typeof value.getState === 'function' || typeof value.dangerouslyGetState === 'function')
        ) return index;
      }
      return -1;
    }
    function routeScope(route, navigation, start, end, transparent) {
      var record = readRouteRecord(route);
      if (!record) throw new Error('invalid scope route');
      return { route: record, navigation: navigation, start: start, end: end, transparent: transparent };
    }
    var routeOwner = null;
    var inactiveOwner = false;
    var boundControls = [];
    try {
      var exactHosts = new Set();
      for (var hostIndex = 0; hostIndex < matches.length; hostIndex++) {
        if (matches[hostIndex].tag === 5) exactHosts.add(matches[hostIndex]);
      }
      var ownershipTarget = exactHosts.size === 1 ? exactHosts.values().next().value : target;
      var ancestry = [];
      var current = ownershipTarget;
      while (current && ancestry.length < 1000) {
        ancestry.push(current);
        current = current.return;
      }
      if (current) throw new Error('incomplete route ancestry');
      var scopes = [];
      for (var ownerIndex = 0; ownerIndex < ancestry.length; ownerIndex++) {
        var ownerFiber = ancestry[ownerIndex];
        var ownerProps = ownerFiber.memoizedProps;
        if (!ownerProps || typeof ownerProps !== 'object') continue;
        var isDestination = 'route' in ownerProps && 'descriptor' in ownerProps
          && ('focused' in ownerProps || 'onPress' in ownerProps) && !('navigation' in ownerProps);
        if (isDestination) {
          var destination = readRouteRecord(ownerProps.route);
          var descriptor = ownerProps.descriptor;
          if (
            exactHosts.size !== 1 || !destination
            || typeof ownerProps.focused !== 'boolean' || typeof ownerProps.onPress !== 'function'
            || !descriptor || !sameRoute(descriptor.route, destination)
          ) throw new Error('invalid destination control');
          var navigatorIndex = ownerIndex + 1;
          while (navigatorIndex < ancestry.length) {
            var possibleNavigator = ancestry[navigatorIndex].memoizedProps;
            if (possibleNavigator && typeof possibleNavigator === 'object' && 'descriptors' in possibleNavigator) break;
            navigatorIndex++;
          }
          if (navigatorIndex === ancestry.length) throw new Error('unbound destination control');
          var navigatorProps = ancestry[navigatorIndex].memoizedProps;
          var descriptors = navigatorProps.descriptors;
          var localState = navigatorProps.state;
          validateRouteMembership(localState, destination);
          if (
            !descriptors || typeof descriptors !== 'object' || Array.isArray(descriptors)
            || descriptors[destination.key] !== descriptor
          ) throw new Error('unbound destination descriptor');
          var selectedRoute = localState.routes[localState.index];
          var selectedDescriptor = descriptors[selectedRoute.key];
          if (!selectedDescriptor || !sameRoute(selectedDescriptor.route, selectedRoute)) {
            throw new Error('invalid selected descriptor');
          }
          var selectedScope = readBoundRoute(selectedDescriptor.navigation, selectedRoute);
          var destinationScope = readBoundRoute(descriptor.navigation, destination);
          var navigatorNavigation = navigatorProps.navigation;
          if (!navigatorNavigation || typeof navigatorNavigation.isFocused !== 'function') {
            throw new Error('invalid navigator focus');
          }
          var navigatorFocused = navigatorNavigation.isFocused();
          if (
            typeof navigatorFocused !== 'boolean'
            || !sameRouteState(localState, selectedScope.state)
            || !sameRouteState(localState, destinationScope.state)
            || selectedScope.focused !== navigatorFocused
            || ownerProps.focused !== (destination.key === selectedRoute.key)
            || destinationScope.focused !== (ownerProps.focused && navigatorFocused)
          ) throw new Error('inconsistent destination binding');
          boundControls.push({ start: ownerIndex, end: navigatorIndex, route: destination, navigation: descriptor.navigation });
          if (!navigatorFocused) inactiveOwner = true;
        }
        if ('route' in ownerProps && 'navigation' in ownerProps) {
          scopes.push(routeScope(ownerProps.route, ownerProps.navigation, ownerIndex, ownerIndex,
            hasOnlyProps(ownerProps, ['route', 'navigation', 'children'])));
        }
        if ('descriptor' in ownerProps && !isDestination) {
          var ownedDescriptor = ownerProps.descriptor;
          if (!ownedDescriptor || typeof ownedDescriptor !== 'object') throw new Error('invalid owned descriptor');
          scopes.push(routeScope(ownedDescriptor.route, ownedDescriptor.navigation, ownerIndex, ownerIndex, false));
        }
        if (ownerProps.scene && typeof ownerProps.scene === 'object' && 'descriptor' in ownerProps.scene) {
          var sceneDescriptor = ownerProps.scene.descriptor;
          if (!sceneDescriptor || typeof sceneDescriptor !== 'object') throw new Error('invalid scene descriptor');
          scopes.push(routeScope(sceneDescriptor.route, sceneDescriptor.navigation, ownerIndex, ownerIndex, false));
        }
        if (ownerFiber.tag === 10 && readRouteRecord(ownerProps.value)) {
          var pairIndex = adjacentNavigationContext(ancestry, ownerIndex, -1);
          if (pairIndex < 0) pairIndex = adjacentNavigationContext(ancestry, ownerIndex, 1);
          if (pairIndex >= 0) {
            var pairProps = ancestry[pairIndex].memoizedProps;
            scopes.push(routeScope(ownerProps.value, pairProps.value,
              Math.min(ownerIndex, pairIndex), Math.max(ownerIndex, pairIndex),
              hasOnlyProps(ownerProps, ['value', 'children'])
                && hasOnlyProps(pairProps, ['value', 'children'])));
          }
        }
      }
      for (var scopeIndex = 0; scopeIndex < scopes.length; scopeIndex++) {
        var scope = scopes[scopeIndex];
        var destinationProvider = false;
        for (var controlIndex = 0; controlIndex < boundControls.length; controlIndex++) {
          var control = boundControls[controlIndex];
          if (scope.transparent && scope.start > control.start && scope.end < control.end) {
            if (!sameRoute(scope.route, control.route) || scope.navigation !== control.navigation) {
              throw new Error('conflicting destination provider');
            }
            destinationProvider = true;
          }
        }
        if (destinationProvider) continue;
        var focused = readBoundRoute(scope.navigation, scope.route).focused;
        if (!routeOwner) routeOwner = scope.route.name;
        if (!focused) inactiveOwner = true;
      }
    } catch (_) {
      return JSON.stringify({
        visible: false,
        reason: 'frontmost route ownership cannot be proven',
        code: 'ASSERTION_FAILED',
        activeRoute: activeRoute,
        matchCount: 1
      });
    }
    if (inactiveOwner) {
      return JSON.stringify({
        visible: false,
        reason: 'testID belongs to an inactive mounted route',
        route: routeOwner,
        activeRoute: activeRoute,
        matchCount: 1
      });
    }
    if (!routeOwner && boundControls.length === 0) {
      var cursor = nav;
      var stacked = false;
      while (cursor) {
        if (Array.isArray(cursor.stack) && cursor.stack.length > 1) stacked = true;
        if (Array.isArray(cursor.routes) && cursor.routes.length > 1) stacked = true;
        if (cursor.nested) {
          cursor = cursor.nested;
        } else if (Array.isArray(cursor.routes) && cursor.routes.length > 0) {
          var cursorIndex = typeof cursor.index === 'number' ? cursor.index : cursor.routes.length - 1;
          var cursorRoute = cursor.routes[Math.max(0, Math.min(cursorIndex, cursor.routes.length - 1))];
          cursor = cursorRoute && cursorRoute.state;
        } else {
          cursor = null;
        }
      }
      if (stacked && modals.length === 0) {
        return JSON.stringify({
          visible: false,
          reason: 'testID has no route owner in a multi-route navigation tree',
          activeRoute: activeRoute,
          matchCount: 1
        });
      }
    }

    return JSON.stringify({
      visible: true,
      route: routeOwner,
      activeRoute: activeRoute,
      modalCount: modals.length,
      matchCount: 1,
      disabled: targetDisabled
    });
  }

  // #379: JS-first keyboard dismissal for the KEYBOARD_OCCLUDED auto-heal.
  // Deterministic (no gestures, no QuickPath corruption): prefer the RN
  // Keyboard module; fall back to blurring the focused TextInput host
  // instance (RN attaches isFocused()/blur() to it), which resigns first
  // responder / hides the IME on both platforms.
  function dismissKeyboard() {
    try {
      var method = null;
      try {
        var RN = require('react-native');
        if (RN && RN.Keyboard && typeof RN.Keyboard.dismiss === 'function') {
          RN.Keyboard.dismiss();
          method = 'keyboard-module';
        }
      } catch (e) { /* require-by-name unavailable (bridgeless/Metro) */ }
      if (!method) {
        var blurred = 0;
        var blurredWithoutFocusOracle = 0;
        var blurredHostInstances = new WeakSet();
        var scanned = 0;
        forEachRootFiber(function (rootFiber) {
          var stack = [rootFiber];
          while (stack.length) {
            if (++scanned > 20000) return true; // bounded walk, stop all roots
            var f = stack.pop();
            if (!f) continue;
            var sn = f.stateNode;
            var blurInstance = sn;
            // Bridgeless Fabric stores the public ReactNativeElement under
            // stateNode.canonical.publicInstance; the host stateNode itself is
            // only an internal {node, canonical} record with no focus methods.
            if (
              blurInstance &&
              typeof blurInstance.blur !== 'function' &&
              blurInstance.canonical &&
              blurInstance.canonical.publicInstance
            ) {
              blurInstance = blurInstance.canonical.publicInstance;
            }
            if (blurInstance && typeof blurInstance.blur === 'function') {
              try {
                if (typeof blurInstance.isFocused === 'function') {
                  if (blurInstance.isFocused()) {
                    blurInstance.blur();
                    blurred++;
                  }
                } else {
                  // Some host adapters expose focus()/blur() but no isFocused()
                  // oracle. Restrict the no-oracle call to RN's native text-input
                  // host fibers; blur() is idempotent for an unfocused input,
                  // and the caller still proves the keyboard
                  // hidden before reporting success or dispatching a tap.
                  var fiberType = '';
                  if (typeof f.type === 'string') fiberType = f.type;
                  else if (f.type && typeof f.type.displayName === 'string') fiberType = f.type.displayName;
                  else if (f.type && typeof f.type.name === 'string') fiberType = f.type.name;
                  if (
                    /textinput|textfield|textview/i.test(fiberType) &&
                    !blurredHostInstances.has(blurInstance)
                  ) {
                    blurredHostInstances.add(blurInstance);
                    blurInstance.blur();
                    blurredWithoutFocusOracle++;
                  }
                }
              } catch (e) {}
            }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
          }
          return null;
        });
        if (blurred > 0) method = 'blur-focused-input';
        else if (blurredWithoutFocusOracle > 0) method = 'blur-text-input-hosts';
      }
      if (!method) {
        return JSON.stringify({
          dismissed: false,
          reason: 'no focused input found and Keyboard module unavailable'
        });
      }
      return JSON.stringify({ dismissed: true, method: method });
    } catch (e) {
      return JSON.stringify({ dismissed: false, error: (e && e.message) || String(e) });
    }
  }

  // Public API
  globalThis.__QAREN = {
    __v: __HELPERS_VERSION__,
    dismissKeyboard: dismissKeyboard,
    getTree: function(opts) { return getTree(opts); },
    getNavState: getNavState,
    getNavGraph: getNavGraph,
    navigateTo: navigateTo,
    getStoreState: getStoreState,
    getComponentState: getComponentState,
    readInputValue: readInputValue,
    releaseInputDesignation: releaseInputDesignation,
    dispatchAction: dispatchAction,
    getErrors: getErrors,
    clearErrors: clearErrors,
    getConsole: getConsole,
    clearConsole: clearConsole,
    interact: interact,
    resolveLadder: resolveLadder,
    __collectAnchors: __collectAnchors,
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    __hidden: __hidden,
    __accessibleName: __accessibleName,
    __match: __match,
    __hostKind: hostKind,
    __role: __role,
    isTestIdFrontmost: isTestIdFrontmost,
    isReady: function() {
      // B145: ready when ANY renderer has at least one root fiber. The
      // single-renderer short-circuit from findActiveRenderer would return
      // true as soon as LogBox mounted — before the app tree was ready.
      return findAllRootFibers().length > 0;
    },
    getAppInfo: function() {
      try {
        var info = {
          __DEV__: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
          hermes: typeof HermesInternal !== 'undefined',
          platform: null,
          version: null,
          rnVersion: null,
          dimensions: null
        };
        // B44 fix: try TurboModule first (works in Bridgeless), then require() fallback
        try {
          if (typeof __turboModuleProxy === 'function') {
            var pc = __turboModuleProxy('PlatformConstants');
            if (pc) {
              info.platform = pc.OS || pc.interfaceIdiom || null;
              info.version = pc.osVersion || pc.Version || null;
              info.rnVersion = pc.reactNativeVersion || null;
            }
          }
        } catch(e) {}
        // Fallback: require() works in Classic bridge mode
        if (!info.platform) {
          try {
            var RN = require('react-native');
            info.platform = RN.Platform.OS;
            info.version = RN.Platform.Version;
            info.dimensions = RN.Dimensions.get('window');
          } catch(e) {}
        }
        if (!info.rnVersion) {
          try {
            info.rnVersion = require('react-native/Libraries/Core/ReactNativeVersion').version;
          } catch(e) {}
        }
        // Dimensions fallback via Dimensions module (may be available even when require fails)
        if (!info.dimensions) {
          try {
            if (typeof globalThis.nativeModuleProxy !== 'undefined') {
              var dims = globalThis.nativeModuleProxy.DeviceInfo && globalThis.nativeModuleProxy.DeviceInfo.Dimensions;
              if (dims && dims.window) info.dimensions = dims.window;
            }
          } catch(e) {}
        }
        try {
          var fabric = typeof globalThis.nativeFabricUIManager === 'object'
            && globalThis.nativeFabricUIManager !== null;
          var bridge = typeof globalThis.__fbBatchedBridge === 'object'
            && globalThis.__fbBatchedBridge !== null;
          info.architecture = fabric ? 'new' : (bridge ? 'old' : 'unknown');
        } catch (e) {
          info.architecture = 'unknown';
        }
        return JSON.stringify(info);
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    }
  };
  Object.defineProperties(globalThis.__QAREN, {
    beginQaCapture: { value: beginQaCapture },
    readQaCapture: { value: readQaCapture }
  });
})();
`;

export const NETWORK_HOOK_SCRIPT = `
(function() {
  if (globalThis.__QAREN_NETWORK_HOOK__) return;
  globalThis.__QAREN_NETWORK_HOOK__ = true;

  // D597: Response body cache for hook mode — enables cdp_network_body on RN < 0.83
  var bodyCache = new Map();
  var MAX_BODIES = 50;
  globalThis.__QAREN_RESPONSE_BODIES__ = bodyCache;

  var origFetch = globalThis.fetch;
  globalThis.fetch = function(url, opts) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var method = (opts && opts.method) || 'GET';
    var start = Date.now();

    if (globalThis.__QAREN_NETWORK_CB__) {
      globalThis.__QAREN_NETWORK_CB__('request', { id: id, method: method, url: String(url) });
    }

    try {
      return origFetch.apply(this, arguments).then(function(response) {
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: response.status, duration_ms: Date.now() - start
          });
        }
        // Cache cloned response body for cdp_network_body
        try {
          response.clone().text().then(function(text) {
            if (bodyCache.size >= MAX_BODIES) {
              var oldest = bodyCache.keys().next().value;
              bodyCache.delete(oldest);
            }
            bodyCache.set(id, text);
          }).catch(function() {});
        } catch(e) {}
        return response;
      }).catch(function(err) {
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: 0, duration_ms: Date.now() - start
          });
        }
        throw err;
      });
    } catch(syncErr) {
      if (globalThis.__QAREN_NETWORK_CB__) {
        globalThis.__QAREN_NETWORK_CB__('response', {
          id: id, status: 0, duration_ms: Date.now() - start
        });
      }
      throw syncErr;
    }
  };

  var OrigXHR = globalThis.XMLHttpRequest;
  if (OrigXHR) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function(method, url) {
      this.__rn_agent_method = method;
      this.__rn_agent_url = url;
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function() {
      var self = this;
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var start = Date.now();
      var reported = false;

      function reportResponse(status) {
        if (reported) return;
        reported = true;
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: status, duration_ms: Date.now() - start
          });
        }
      }

      if (globalThis.__QAREN_NETWORK_CB__) {
        globalThis.__QAREN_NETWORK_CB__('request', {
          id: id, method: self.__rn_agent_method || 'GET', url: String(self.__rn_agent_url || '')
        });
      }

      self.addEventListener('load', function() { reportResponse(self.status); });
      self.addEventListener('error', function() { reportResponse(0); });
      self.addEventListener('abort', function() { reportResponse(0); });
      self.addEventListener('timeout', function() { reportResponse(0); });

      return origSend.apply(this, arguments);
    };
  }
})();
`;

/**
 * Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network callback.
 * Pushes entries into an in-app ring buffer instead of console.log so the
 * shared console stream (Metro logs, user DevTools) stays clean. The bridge
 * drains the buffer on demand (cdp/net-hook-drain.ts). Idempotent: preserves
 * an existing buffer so reinjection doesn't lose undrained entries.
 */
export const NETWORK_CB_BUFFERED_SCRIPT = `
(function() {
  globalThis.__QAREN_NET_BUF__ = globalThis.__QAREN_NET_BUF__ || [];
  var MAX = 100;
  globalThis.__QAREN_NETWORK_CB__ = function(type, data) {
    try {
      var buf = globalThis.__QAREN_NET_BUF__;
      if (!Array.isArray(buf)) { buf = []; globalThis.__QAREN_NET_BUF__ = buf; }
      buf.push({ t: type, d: data, ts: Date.now() });
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    } catch (e) {}
  };
})();
`;

// M8 + GH #597: readiness probe for waitForReact. Combine renderer IDs from
// the DevTools registry with M8's bounded numeric range so setup recognizes
// sparse/high renderers without regressing empty, malformed, or partial shims.
export const REACT_READY_PROBE_JS = `(function() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || typeof h.getFiberRoots !== 'function') return false;
  var ids = [];
  try {
    if (h.renderers && typeof h.renderers.keys === 'function') {
      var iterator = h.renderers.keys();
      var step;
      var iterations = 0;
      while (iterator && typeof iterator.next === 'function' && !(step = iterator.next()).done) {
        if (++iterations > 100) { ids = []; break; }
        if (typeof step.value === 'number' && ids.indexOf(step.value) === -1) ids.push(step.value);
      }
    }
  } catch (_) { ids = []; }
  for (var fallbackId = 1; fallbackId <= 20; fallbackId++) {
    if (ids.indexOf(fallbackId) === -1) ids.push(fallbackId);
  }
  for (var i = 0; i < ids.length; i++) {
    try {
      var r = h.getFiberRoots(ids[i]);
      if (r && r.size > 0) return true;
    } catch (_) { /* one throwing renderer must not abort the readiness scan */ }
  }
  return false;
})()`;

// B143: exported TS mirror of the in-IIFE `findAllRootFibers()` inside
// INJECTED_HELPERS. The in-IIFE copy MUST be kept in sync with this logic.
// Tests exercise this mirror; the IIFE version runs in Hermes as pure JS.
// See test/unit/component-tree-multi-renderer.test.js for the contract.
//
// GH #597: union hook.renderers with Issue #126's bounded numeric range so
// every registered root is considered without regressing partial hook shims.
// The early-exit heuristic remains for scans with no usable registry.
export interface FiberLike {
  current?: unknown;
}
export interface RendererRootsLike {
  size: number;
  values(): Iterator<{ current?: unknown } | null | undefined>;
}
export interface DevToolsHookLike {
  renderers?: { keys(): Iterator<number> } | null;
  getFiberRoots?: (rendererId: number) => RendererRootsLike | null | undefined;
}

export const MAX_RENDERER_IDS = 20;
export const MAX_REGISTERED_RENDERER_IDS = 100;
export const EARLY_EXIT_EMPTY_STREAK = 3;

export function findAllRootFibersForTest(
  hook: DevToolsHookLike | null | undefined,
): Array<{ rendererId: number; fiber: unknown }> {
  if (!hook || typeof hook.getFiberRoots !== 'function') return [];
  const out: Array<{ rendererId: number; fiber: unknown }> = [];
  let rendererIds: number[] = [];
  try {
    if (hook.renderers && typeof hook.renderers.keys === 'function') {
      const iterator = hook.renderers.keys();
      let step = iterator.next();
      let iterations = 0;
      while (!step.done) {
        if (++iterations > MAX_REGISTERED_RENDERER_IDS) {
          rendererIds = [];
          break;
        }
        const id = step.value;
        if (typeof id === 'number' && !rendererIds.includes(id)) rendererIds.push(id);
        step = iterator.next();
      }
    }
  } catch {
    rendererIds = [];
  }
  const usingRegisteredIds = rendererIds.length > 0;
  for (let fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
    if (!rendererIds.includes(fallbackId)) rendererIds.push(fallbackId);
  }
  let emptyStreak = 0;
  for (const ri of rendererIds) {
    try {
      const roots = hook.getFiberRoots(ri);
      if (roots && roots.size) {
        emptyStreak = 0;
        const it = roots.values();
        let step = it.next();
        while (!step.done) {
          const r = step.value;
          if (r && r.current) out.push({ rendererId: ri, fiber: r.current });
          step = it.next();
        }
      } else if (!usingRegisteredIds) {
        emptyStreak++;
        if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) return out;
      }
    } catch {
      if (!usingRegisteredIds) emptyStreak++;
    }
  }
  return out;
}
