import type { ToolResult } from '../utils.js';
import { okResult } from '../utils.js';

export interface CloseDeviceSessionDeps {
  hasActiveSession: () => boolean;
  closeUnderlyingSession: () => Promise<ToolResult>;
  clearActiveSession: () => void;
  // GH #383: adoption-aware teardown needs the closing session's deviceId so a
  // post-respawn stop reaps the persisted per-device runner instead of no-oping.
  stopFastRunner: (deviceId?: string) => void | Promise<void>;
  terminateRunnerHost?: (deviceId?: string) => Promise<void>;
  // GH #383: mirror stopFastRunner — pass the closing session's deviceId so a
  // post-respawn stop reaps the persisted per-device runner instead of no-oping.
  stopAndroidRunner: (deviceId?: string) => Promise<void>;
  finalizeSuccessfulClose: () => void | Promise<void>;
  getDeviceId?: () => string | undefined;
}

/**
 * GH#244: after a Maestro flow tears down the runner/daemon (the #237 slot-release),
 * the in-memory session survives but the agent-device session that `close` routes
 * through is gone — the CLI returns SESSION_NOT_FOUND. Treat ONLY that shape as
 * benign; any other error is a real close failure and is surfaced unchanged.
 *
 * Match on the STRUCTURED code first (runAgentDevice → failResult(msg, { code, hint })
 * puts it under meta.code), then a narrow message fallback applied ONLY to the error
 * field — never the whole serialized envelope, so an unrelated failure whose hint
 * mentions the phrase can't be misclassified as benign.
 */
export function isBenignSessionGoneError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  let envelope: { error?: string; code?: string; meta?: { code?: string } };
  try {
    envelope = JSON.parse(text) as { error?: string; code?: string; meta?: { code?: string } };
  } catch {
    // B192: unparseable payload → no error field to scope the match to. Never
    // classify as benign; surface it so a real failure can't be swallowed just
    // because its raw text mentions the phrase.
    return false;
  }
  if ((envelope.meta?.code ?? envelope.code) === 'SESSION_NOT_FOUND') return true;
  return /no active session|session not found/i.test(envelope.error ?? '');
}

export async function closeDeviceSession(deps: CloseDeviceSessionDeps): Promise<ToolResult> {
  if (!deps.hasActiveSession()) {
    await deps.finalizeSuccessfulClose();
    return okResult({ closed: true, message: 'No active session to close' });
  }

  // GH #383: read the closing session's deviceId before clearActiveSession()
  // wipes it, so the adoption-aware stopFastRunner reaps the right per-device runner.
  const deviceId = deps.getDeviceId?.();
  const finalizeClose = async (): Promise<void> => {
    await deps.stopFastRunner(deviceId);
    await deps.terminateRunnerHost?.(deviceId);
    await deps.stopAndroidRunner(deviceId);
    await deps.finalizeSuccessfulClose();
    deps.clearActiveSession();
  };

  const result = await deps.closeUnderlyingSession();

  if (!result.isError) {
    await finalizeClose();
    return result;
  }

  if (isBenignSessionGoneError(result)) {
    await finalizeClose();
    return okResult({
      closed: true,
      sessionAlreadyGone: true,
      message:
        'Underlying device session was already gone (likely torn down by a Maestro flow); cleared local session state.',
    });
  }

  return result;
}
