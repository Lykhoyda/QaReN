import type { CDPClient } from '../cdp-client.js';
import { ReplayDispatchError } from '../domain/cdp-flow-replay.js';
import type { SessionState } from '../types.js';
import { createComponentTreeHandler } from './component-tree.js';
import {
  createReplayPressByTestId,
  replayTreeData,
  unwrapTree,
  type CdpReplayDeps,
} from './cdp-replay-dispatch.js';
import { performReactTreeInput } from './device-interact.js';
import { createInteractHandler } from './interact.js';

interface MakeReplayDepsDependencies {
  getActiveSession(): SessionState | null;
  getClient(): CDPClient;
  resolveIosUdid(deviceId?: string): Promise<string | undefined>;
  execute(file: string, args: string[]): Promise<unknown>;
}

const mustOk = (res: { content: { text: string }[] }, what: string): void => {
  const env = JSON.parse(res.content[0].text) as {
    ok?: boolean;
    code?: string;
    error?: string;
    meta?: Record<string, unknown>;
  };
  if (env.ok === false)
    throw new ReplayDispatchError(
      env.code ?? 'INTERACTION_NOT_ACTUATED',
      `${what} failed: ${env.error ?? 'ok:false'}`,
      env.meta,
    );
};

export function makeReplayDeps(
  deps: MakeReplayDepsDependencies,
  signal?: AbortSignal,
): CdpReplayDeps | null {
  const session = deps.getActiveSession();
  if (!session || session.platform !== 'ios' || !session.appId) return null;
  const interact = createInteractHandler(deps.getClient);
  const tree = createComponentTreeHandler(deps.getClient);
  return {
    pressByTestId: createReplayPressByTestId(interact),
    typeByTestId: async (id: string, text: string, context) => {
      mustOk(
        await performReactTreeInput(
          id,
          text,
          deps.getClient(),
          signal,
          context ? { designationToken: context.designationToken } : {},
        ),
        `type "${id}"`,
      );
    },
    releaseInputDesignation: async (token: string) => {
      try {
        await deps
          .getClient()
          .evaluate(`__QAREN.releaseInputDesignation(${JSON.stringify(token)})`);
      } catch {}
    },
    treeFor: async (id: string) => {
      const fetchTree = async (interactiveOnly: boolean) =>
        JSON.parse(
          (
            await tree({
              filter: id,
              depth: 12,
              ...(interactiveOnly ? { interactiveOnly: true } : {}),
            })
          ).content[0].text,
        ) as {
          ok?: boolean;
          code?: string;
          error?: string;
          data?: unknown;
          meta?: Record<string, unknown>;
        };
      let env = await fetchTree(false);
      // Retry with the salient digest when the full filtered payload exceeds the helper bound.
      const d = env.data as Record<string, unknown> | null;
      if (d && typeof d === 'object' && ('__agent_truncated' in d || d.truncated === true)) {
        env = await fetchTree(true);
      }
      return unwrapTree(replayTreeData(env));
    },
    frontmostFor: async (id: string) => {
      const client = deps.getClient();
      const result = await client.evaluate(
        client.bridgeWithFallback(`isTestIdFrontmost(${JSON.stringify(id)})`),
      );
      if (result.error || typeof result.value !== 'string') {
        return {
          visible: false,
          reason: `frontmost route check failed for testID "${id}"`,
          code: 'ASSERTION_FAILED',
        };
      }
      try {
        const parsed = JSON.parse(result.value) as {
          visible?: boolean;
          disabled?: boolean;
          reason?: string;
          matchCount?: number;
          code?: string;
          coverage?: unknown;
        };
        return {
          visible: parsed.visible === true,
          ...(typeof parsed.disabled === 'boolean' ? { disabled: parsed.disabled } : {}),
          ...(parsed.reason ? { reason: parsed.reason } : {}),
          ...(typeof parsed.matchCount === 'number' ? { matchCount: parsed.matchCount } : {}),
          ...(parsed.code ? { code: parsed.code } : {}),
          ...(parsed.coverage &&
          typeof parsed.coverage === 'object' &&
          !Array.isArray(parsed.coverage)
            ? { coverage: parsed.coverage as Record<string, unknown> }
            : {}),
        };
      } catch {
        return {
          visible: false,
          reason: `frontmost route check was unreadable for testID "${id}"`,
          code: 'ASSERTION_FAILED',
        };
      }
    },
    launchApp: async (stopApp: boolean) => {
      const udid = await deps.resolveIosUdid(session.deviceId);
      if (!udid) throw new Error('launchApp: could not resolve iOS udid');
      if (stopApp) {
        try {
          await deps.execute('xcrun', ['simctl', 'terminate', udid, session.appId!]);
        } catch {
          /* app not running — fine */
        }
      }
      await deps.execute('xcrun', ['simctl', 'launch', udid, session.appId!]);
    },
    settle: async (timeoutMs: number) => {
      if (signal?.aborted) throw new ReplayDispatchError('RUNNER_TIMEOUT', 'Replay cancelled');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, timeoutMs);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new ReplayDispatchError('RUNNER_TIMEOUT', 'Replay cancelled'));
          },
          { once: true },
        );
      });
    },
  };
}
