import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection, pickDefined } from '../utils.js';

// Diagnostics the injected interact attaches to a refusal — the caller needs
// them to pick a different selector (GH #525 walkUp refusals included).
const REFUSAL_FIELDS = [
  'hint',
  'walkUpSearched',
  'count',
  'candidates',
  'matches',
  'truncated',
  'reason',
  'scanned',
  'work',
  'workLimit',
  'handlerCalled',
] as const;

type InteractAction = 'press' | 'longPress' | 'typeText' | 'scroll' | 'setFieldValue';

export interface InteractArgs {
  action: InteractAction;
  testID?: string;
  accessibilityLabel?: string;
  text?: string;
  scrollX?: number;
  scrollY?: number;
  animated: boolean;
  // setFieldValue — see injected-helpers.ts setFieldValue handler.
  name?: string;
  value?: string | number | boolean;
  shouldValidate?: boolean;
  shouldDirty?: boolean;
  // Discovery ladder (resolveLadder) selector facts.
  role?: string;
  placeholder?: string;
  exact?: boolean;
  includeHidden?: boolean;
  // GH #525 — press-only opt-in pressable-ancestor discovery.
  walkUp?: boolean;
  allowInputDesignation?: boolean;
}

export function createInteractHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: InteractArgs, client) => {
    const hasLadderSelector =
      args.action === 'typeText'
        ? Boolean(args.placeholder || (args.role && args.name))
        : Boolean(args.role || args.text || args.placeholder);
    if (!args.testID && !args.accessibilityLabel && !hasLadderSelector) {
      return failResult(
        'A selector is required: testID / accessibilityLabel, or a discovery-ladder selector (role / text / placeholder).',
      );
    }
    if (args.action === 'typeText' && args.text === undefined) {
      return failResult('text parameter is required for typeText action');
    }
    if (args.action === 'setFieldValue') {
      if (args.name === undefined || args.name.length === 0) {
        return failResult(
          'name parameter is required for setFieldValue action — the React Hook Form field name',
        );
      }
      if (args.value === undefined) {
        return failResult('value parameter is required for setFieldValue action');
      }
    }

    const opts: Record<string, unknown> = { action: args.action };
    if (args.testID !== undefined) opts.testID = args.testID;
    if (args.accessibilityLabel !== undefined) opts.accessibilityLabel = args.accessibilityLabel;
    if (args.text !== undefined) opts.text = args.text;
    if (args.scrollX !== undefined) opts.scrollX = args.scrollX;
    if (args.scrollY !== undefined) opts.scrollY = args.scrollY;
    opts.animated = args.animated;
    if (args.name !== undefined) opts.name = args.name;
    if (args.value !== undefined) opts.value = args.value;
    if (args.shouldValidate !== undefined) opts.shouldValidate = args.shouldValidate;
    if (args.shouldDirty !== undefined) opts.shouldDirty = args.shouldDirty;
    if (args.role !== undefined) opts.role = args.role;
    if (args.placeholder !== undefined) opts.placeholder = args.placeholder;
    if (args.exact !== undefined) opts.exact = args.exact;
    if (args.includeHidden !== undefined) opts.includeHidden = args.includeHidden;
    if (args.walkUp !== undefined) opts.walkUp = args.walkUp;
    if (args.allowInputDesignation !== undefined)
      opts.allowInputDesignation = args.allowInputDesignation;

    const result = await client.evaluate(`__QAREN.interact(${JSON.stringify(opts)})`);

    if (result.error) {
      return failResult(`Interact error: ${result.error}`);
    }

    if (typeof result.value !== 'string') {
      return failResult('Unexpected response from interact — expected JSON string');
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(result.value) as Record<string, unknown>;
    } catch {
      return failResult(`Interact returned non-JSON: ${result.value.slice(0, 200)}`);
    }

    if (parsed.error) {
      const refusal = pickDefined(parsed, REFUSAL_FIELDS);
      return parsed.code === 'ASSERTION_FAILED'
        ? failResult(`Interact failed: ${parsed.error}`, 'ASSERTION_FAILED', refusal)
        : failResult(`Interact failed: ${parsed.error}`, refusal);
    }

    // GH#250: a handler throw is an app-side failure, not a warning — the action
    // dispatched but its effect likely didn't happen. actionExecuted in meta keeps
    // the "dispatched but threw" / "couldn't dispatch" distinction.
    if (parsed.action_executed && parsed.handler_error) {
      return failResult(`Action executed but handler threw: ${parsed.handler_error}`, {
        actionExecuted: true,
        handlerError: parsed.handler_error,
        hint: 'The app handler raised an exception — the screen may be in an error state. Check cdp_error_log before continuing.',
      });
    }

    return okResult(parsed);
  });
}
