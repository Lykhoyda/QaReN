import {
  normalizeSteps,
  replayFlow,
  ReplayDispatchError,
  type ReplayResult,
  type ReplayPressResult,
  type ReplayTypeContext,
} from '../domain/cdp-flow-replay.js';
import type { ReplayDispatch } from '../domain/cdp-flow-replay.js';
import type { createInteractHandler } from './interact.js';

// Unwrap getTree's `{ tree: <node>|{matches} }` envelope to the node(s) the
// dispatch helpers walk. Returns the bare node for a single match, the
// `{ matches: [...] }` wrapper for multiple, or the input unchanged when it is
// already a node. Used at the treeFor boundary in cdp-replay-deps.ts.
export function unwrapTree(data: unknown): unknown {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return 'tree' in d ? d.tree : d;
}

export interface ReplayTreeEnvelope {
  ok?: boolean;
  code?: string;
  error?: string;
  data?: unknown;
  meta?: Record<string, unknown>;
}

// Readability gate only: transport, redbox, truncation, and serialization failures reject.
export function replayTreeData(envelope: ReplayTreeEnvelope): unknown {
  const warning = typeof envelope.meta?.warning === 'string' ? envelope.meta.warning : undefined;
  const redbox = warning === 'APP_HAS_REDBOX';
  const data =
    envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : null;
  const truncated = data !== null && (data.__agent_truncated === true || data.truncated === true);
  const agentError =
    typeof data?.__agent_error === 'string' ? data.__agent_error.slice(0, 1000) : undefined;
  const serializationFailed = agentError !== undefined;
  if (envelope.ok === true && !redbox && !truncated && !serializationFailed) return envelope.data;

  const message = serializationFailed
    ? agentError || 'Component tree serialization failed'
    : truncated
      ? 'Component tree proof exceeded the readable payload budget'
      : redbox && typeof data?.message === 'string'
        ? data.message.slice(0, 1000)
        : (envelope.error?.slice(0, 1000) ?? 'Component tree proof is unavailable');
  const code = serializationFailed
    ? 'EVAL_FAILED'
    : redbox
      ? warning
      : (envelope.code ?? 'EVAL_FAILED');
  throw new ReplayDispatchError(code, message, {
    treeEnvelope: {
      ok: envelope.ok === true,
      ...(serializationFailed ? { agentError } : {}),
      ...(truncated ? { truncated: true } : {}),
      ...(truncated && typeof data.originalLength === 'number'
        ? { originalLength: data.originalLength }
        : {}),
      ...(envelope.code ? { code: envelope.code } : {}),
      ...(envelope.error ? { error: envelope.error.slice(0, 1000) } : {}),
      ...(warning ? { warning } : {}),
      ...(typeof data?.message === 'string' ? { message: data.message.slice(0, 1000) } : {}),
      ...(envelope.meta ? { meta: envelope.meta } : {}),
    },
  });
}

export interface CdpReplayDeps {
  pressByTestId(id: string): Promise<ReplayPressResult | void>;
  typeByTestId(id: string, text: string, context?: ReplayTypeContext): Promise<void>;
  releaseInputDesignation?(token: string): Promise<void>;
  // Returns parsed readable getTree data filtered to `id`.
  treeFor(id: string): Promise<unknown>;
  // Exact-ID oracle; matchCount 0 proves absence, while refusals omit it.
  frontmostFor(id: string): Promise<{
    visible: boolean;
    disabled?: boolean;
    reason?: string;
    matchCount?: number;
    code?: string;
    coverage?: Record<string, unknown>;
  }>;
  launchApp(stopApp: boolean): Promise<void>;
  settle(timeoutMs: number): Promise<void>;
}

export function createReplayPressByTestId(
  interact: ReturnType<typeof createInteractHandler>,
): CdpReplayDeps['pressByTestId'] {
  return async (id) => {
    const result = await interact({
      action: 'press',
      testID: id,
      animated: false,
      walkUp: true,
      allowInputDesignation: true,
    });
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
      ok?: boolean;
      code?: string;
      error?: string;
      data?: { action?: string; focusOnly?: boolean; designationToken?: string };
      meta?: Record<string, unknown>;
    };
    if (envelope.ok === false) {
      throw new ReplayDispatchError(
        envelope.code ?? 'INTERACTION_NOT_ACTUATED',
        `press "${id}" failed: ${envelope.error ?? 'ok:false'}`,
        envelope.meta,
      );
    }
    if (envelope.data?.action !== 'designateTextInput') return { kind: 'press' };
    if (
      envelope.data.focusOnly !== true ||
      typeof envelope.data.designationToken !== 'string' ||
      envelope.data.designationToken.length === 0
    ) {
      throw new ReplayDispatchError(
        'INTERACTION_NOT_ACTUATED',
        `press "${id}" returned an invalid TextInput designation`,
      );
    }
    return {
      kind: 'designation',
      focusOnly: true,
      token: envelope.data.designationToken,
    };
  };
}

function hasDisabledExactMatch(treeJson: unknown, id: string): boolean {
  const stack: unknown[] = [treeJson];
  while (stack.length) {
    const n = stack.pop() as Record<string, unknown> | null;
    if (n && typeof n === 'object') {
      if (n.testID === id || n.nativeID === id) {
        const props =
          n.props && typeof n.props === 'object' && !Array.isArray(n.props)
            ? (n.props as Record<string, unknown>)
            : null;
        if (isDisabled(n) || isDisabled(props)) return true;
      }
      if (n.tree) stack.push(n.tree);
      const kids = n.children ?? n.interactive ?? n.nodes ?? n.matches;
      if (Array.isArray(kids)) stack.push(...kids);
    }
  }
  return false;
}

function nodePath(treeJson: unknown, id: string): Array<Record<string, unknown>> | null {
  const root =
    treeJson && typeof treeJson === 'object' && 'tree' in treeJson
      ? (treeJson as Record<string, unknown>).tree
      : treeJson;
  const visit = (
    value: unknown,
    ancestors: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const node = value as Record<string, unknown>;
    const path = [...ancestors, node];
    if (node.testID === id || node.nativeID === id) return path;
    const children = node.children ?? node.nodes ?? node.matches;
    if (!Array.isArray(children)) return null;
    for (const child of children) {
      const found = visit(child, path);
      if (found) return found;
    }
    return null;
  };
  return visit(root, []);
}

function pointerEventsBlock(treeJson: unknown, id: string): string | null {
  const path = nodePath(treeJson, id);
  if (!path) return null;
  for (let index = 0; index < path.length; index += 1) {
    const node = path[index]!;
    const props = (node.props as Record<string, unknown> | undefined) ?? node;
    const pointerEvents = props.pointerEvents;
    const target = index === path.length - 1;
    if (target && (pointerEvents === 'none' || pointerEvents === 'box-none')) {
      return `the target has pointerEvents="${pointerEvents}"`;
    }
    if (!target && pointerEvents === 'none') return 'an ancestor has pointerEvents="none"';
    if (!target && pointerEvents === 'box-only') {
      return 'an ancestor has pointerEvents="box-only"';
    }
  }
  return null;
}

function isDisabled(props: Record<string, unknown> | null): boolean {
  if (!props) return false;
  const a11y = props.accessibilityState as { disabled?: boolean } | undefined;
  return props.disabled === true || props.editable === false || a11y?.disabled === true;
}

export async function runCdpReplayCommands(
  commands: unknown[],
  params: Record<string, string>,
  deps: CdpReplayDeps,
  opts: { signal?: AbortSignal; initialFocusId?: string } = {},
): Promise<ReplayResult> {
  return replayFlow(normalizeSteps(commands, params), buildCdpDispatch(deps, opts.signal), {
    signal: opts.signal,
    initialFocusId: opts.initialFocusId,
  });
}

export function buildCdpDispatch(deps: CdpReplayDeps, signal?: AbortSignal): ReplayDispatch {
  const requireNotAborted = (): void => {
    if (signal?.aborted) {
      throw new ReplayDispatchError(
        'RUNNER_TIMEOUT',
        'React-tree replay exceeded its execution deadline',
      );
    }
  };
  const assertExactInteractable = async (id: string): Promise<void> => {
    const tree = await deps.treeFor(id);
    requireNotAborted();
    const frontmost = await deps.frontmostFor(id);
    requireNotAborted();
    if (frontmost.matchCount === 0)
      throw new ReplayDispatchError('TESTID_NOT_FOUND', `testID "${id}" not present`, {
        failedSelector: id,
      });
    const matches = frontmost.matchCount ?? 1;
    if (matches > 1)
      throw new ReplayDispatchError(
        'AMBIGUOUS_TESTID',
        `testID "${id}" resolves to ${matches} mounted elements`,
        { matchCount: matches },
      );
    if (!frontmost.visible)
      throw new ReplayDispatchError(
        frontmost.code ?? 'ASSERTION_FAILED',
        frontmost.reason ?? `testID "${id}" is mounted but not frontmost`,
        frontmost.coverage ? { coverage: frontmost.coverage } : undefined,
      );
    if (frontmost.disabled === true || hasDisabledExactMatch(tree, id))
      throw new ReplayDispatchError(
        'INTERACTION_NOT_ACTUATED',
        `testID "${id}" is disabled/non-interactable`,
      );
    const pointerEventsError = pointerEventsBlock(tree, id);
    if (pointerEventsError)
      throw new ReplayDispatchError(
        'INTERACTION_NOT_ACTUATED',
        `testID "${id}" is not user-interactable: ${pointerEventsError}`,
      );
  };

  return {
    async press(id) {
      await assertExactInteractable(id);
      requireNotAborted();
      return deps.pressByTestId(id);
    },
    async type(id, text, context) {
      await assertExactInteractable(id);
      requireNotAborted();
      await deps.typeByTestId(id, text, context);
    },
    async releaseDesignation(token) {
      await deps.releaseInputDesignation?.(token);
    },
    async visibility(id) {
      await deps.treeFor(id);
      const frontmost = await deps.frontmostFor(id);
      if (frontmost.matchCount === 0)
        return {
          visible: false,
          code: 'TESTID_NOT_FOUND',
          reason: `testID "${id}" not present in the React tree`,
          meta: { failedSelector: id },
        };
      const matches = frontmost.matchCount ?? 1;
      if (matches > 1)
        return {
          visible: false,
          code: 'AMBIGUOUS_TESTID',
          reason: `testID "${id}" resolves to ${matches} mounted elements`,
        };
      if (!frontmost.visible)
        return {
          visible: false,
          code: frontmost.code ?? 'ASSERTION_FAILED',
          reason: frontmost.reason ?? `testID "${id}" is mounted but not frontmost`,
          ...(frontmost.coverage ? { meta: { coverage: frontmost.coverage } } : {}),
        };
      return { visible: true };
    },
    async launch(stopApp) {
      await deps.launchApp(stopApp);
    },
    async settle(timeoutMs) {
      await deps.settle(timeoutMs);
    },
  };
}
