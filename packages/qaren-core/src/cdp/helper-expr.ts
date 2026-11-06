const CALL_RE = /^([A-Za-z_$][A-Za-z0-9_$]*)\(([\s\S]*)\)$/;

function serializeArgs(args: string): string {
  if (args.trim() === '') return '';
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (const match of args.matchAll(/"(?:[^"\\]|\\.)*"|[[\]{},]/g)) {
    const token = match[0];
    if (token === '[' || token === '{') depth++;
    else if (token === ']' || token === '}') depth--;
    else if (token === ',' && depth === 0) {
      parts.push(args.slice(start, match.index));
      start = match.index + 1;
    }
  }
  parts.push(args.slice(start));
  return parts
    .map((part) => {
      // An absent argument arrives as JSON.stringify(undefined).
      if (part.trim() === 'undefined') return 'undefined';
      return JSON.stringify(JSON.parse(part));
    })
    .join(', ');
}

/** A helper call proven to be `identifier(<JSON data args>)`, safe to evaluate in the app. */
export type HelperCall = string & { readonly __brand: 'HelperCall' };

export function helperCall(call: string): HelperCall {
  const match = CALL_RE.exec(call);
  if (match) {
    try {
      return `${match[1]}(${serializeArgs(match[2])})`.replace(
        /[<>/\u2028\u2029]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ) as HelperCall;
    } catch {
      // Reject arguments that are neither JSON data nor bare undefined.
    }
  }
  throw new Error(
    `helper-expr: refusing to interpolate untrusted call "${call.slice(0, 80)}"; ` +
      `expected identifier(<args>) where <args> are pure JSON data values.`,
  );
}

// A legacy app-side __RN_DEV_BRIDGE__ answers first; an error reply or a throw falls back to __QAREN.
export function bridgeWithFallback(call: HelperCall, bridgeDetected: boolean): string {
  return bridgeDetected
    ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${call}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __QAREN.${call}; })()`
    : `__QAREN.${call}`;
}
