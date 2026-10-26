// CodeQL js/bad-code-sanitization (alerts #23 #24):
// `call` is interpolated into a JavaScript expression that the MCP server
// sends to Hermes via Runtime.evaluate. All production call sites use hardcoded
// method names + JSON.stringify'd arguments (e.g. `getStoreState(${pathArg}, ${typeArg})`,
// `getConsole(${JSON.stringify(opts)})`), so injection is not reachable in
// practice. validateCall adds defense in depth: it requires `call` to be
// `identifier(<args>)` where <args> is empty or a comma-separated list of pure
// JSON DATA values. JSON data cannot carry executable code (no calls, no
// statements), so an object/array-literal argument — getConsole({...}),
// dispatchAction({...}) — is accepted, while a nested call such as
// `getConsole(stealSecrets())` or any `;`-statement injection is rejected.
// (The previous `[^;{}]*` regex was both too strict — it banned legitimate JSON
// object args, breaking cdp_console_log — and too loose — it let nested calls
// through.)
const CALL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*\(([\s\S]*)\)$/;

function validateCall(call: string): void {
  const match = CALL_RE.exec(call);
  if (match) {
    const args = match[1].trim();
    if (args === '') return;
    // `undefined` is the one non-JSON token a call site may emit (store-state's
    // absent path/type, e.g. `getStoreState(undefined, undefined)`). Normalize
    // it to `null` FOR VALIDATION ONLY — both are inert literals; the original
    // (unmodified) `call` is what actually gets interpolated.
    const forJson = args.replace(/\bundefined\b/g, 'null');
    try {
      JSON.parse(`[${forJson}]`);
      return;
    } catch {
      /* not pure JSON data — fall through to reject */
    }
  }
  throw new Error(
    `helper-expr: refusing to interpolate untrusted call "${call.slice(0, 80)}"; ` +
      `expected identifier(<args>) where <args> are pure JSON data values.`,
  );
}

export function helperExpr(call: string, bridgeDetected: boolean): string {
  validateCall(call);
  return bridgeDetected ? `__RN_DEV_BRIDGE__.${call}` : `__QAREN.${call}`;
}

export function bridgeWithFallback(call: string, bridgeDetected: boolean): string {
  validateCall(call);
  return bridgeDetected
    ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __QAREN.${call}; })()`
    : `__QAREN.${call}`;
}
