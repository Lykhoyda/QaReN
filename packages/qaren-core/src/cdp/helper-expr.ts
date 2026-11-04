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
      // Store-state callers use undefined for an absent path or type.
      if (part.trim() === 'undefined') return 'undefined';
      return JSON.stringify(JSON.parse(part));
    })
    .join(', ');
}

function serializeCall(call: string): string {
  const match = CALL_RE.exec(call);
  if (match) {
    try {
      return `${match[1]}(${serializeArgs(match[2])})`.replace(
        /[<>/\u2028\u2029]/g,
        (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      );
    } catch {
      // Reject arguments that are neither JSON data nor bare undefined.
    }
  }
  throw new Error(
    `helper-expr: refusing to interpolate untrusted call "${call.slice(0, 80)}"; ` +
      `expected identifier(<args>) where <args> are pure JSON data values.`,
  );
}

export function helperExpr(call: string, bridgeDetected: boolean): string {
  const safeCall = serializeCall(call);
  return bridgeDetected ? `__RN_DEV_BRIDGE__.${safeCall}` : `__QAREN.${safeCall}`;
}

export function bridgeWithFallback(call: string, bridgeDetected: boolean): string {
  const safeCall = serializeCall(call);
  return bridgeDetected
    ? `(function() { var fb = false; try { var r = __RN_DEV_BRIDGE__.${safeCall}; var p = JSON.parse(r); if (p && (p.__agent_error || p.error)) fb = true; else return r; } catch(e) { fb = true; } if (fb) return __QAREN.${safeCall}; })()`
    : `__QAREN.${safeCall}`;
}
