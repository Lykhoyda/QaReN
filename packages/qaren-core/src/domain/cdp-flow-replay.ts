export type ReplayStep =
  | { t: 'launch'; stopApp: boolean }
  | { t: 'tap'; id: string }
  | { t: 'type'; text: string }
  | { t: 'waitVisible'; id: string; timeoutMs: number; evidenceType?: 'assert' }
  | { t: 'wait'; timeoutMs: number }
  | { t: 'runFlow'; whenVisible: string; commands: ReplayStep[] };

export class UnsupportedStepError extends Error {
  constructor(readonly stepKey: string) {
    super(`cdp-flow-replay: unsupported Maestro step "${stepKey}" (no CDP/JS mapping)`);
    this.name = 'UnsupportedStepError';
  }
}

export interface ReplayDispatch {
  press(id: string): Promise<ReplayPressResult | void>;
  type(id: string, text: string, context?: ReplayTypeContext): Promise<void>;
  releaseDesignation?(token: string): Promise<void>;
  visibility(id: string): Promise<ReplayVisibility>;
  launch(stopApp: boolean): Promise<void>;
  settle(timeoutMs: number): Promise<void>;
}

export type ReplayPressResult =
  | { kind: 'press' }
  | { kind: 'designation'; focusOnly: true; token: string };

export interface ReplayTypeContext {
  focusOnlyDesignation: true;
  designationToken: string;
}

export interface ReplayVisibility {
  visible: boolean;
  reason?: string;
  code?: string;
  meta?: Record<string, unknown>;
}

export class ReplayDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ReplayDispatchError';
  }
}

export interface ReplayResult {
  passed: boolean;
  finalFocusId?: string | null;
  failedStepIndex?: number;
  failureCode?: string;
  failureMeta?: Record<string, unknown>;
  reason?: string;
  steps: {
    sourceIndex: number;
    t: string;
    target?: string;
    focusOnly?: true;
    ok: boolean;
    durationMs: number;
  }[];
}

export const PARAM_PLACEHOLDER = /\$\{([A-Z_][A-Z0-9_]*)(?:\s*\?\?\s*(['"])(.*?)\2)?\}/g;

export const interp = (s: string, p: Record<string, string>): string =>
  s.replace(
    PARAM_PLACEHOLDER,
    (match, key: string, _quote: string | undefined, fallback: string | undefined) =>
      p[key] ?? fallback ?? match,
  );

const asString = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);
const DEFAULT_VISIBILITY_TIMEOUT_MS = 17_000;
const VISIBILITY_POLL_INTERVAL_MS = 200;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

async function readVisibilityBeforeDeadline(
  dispatch: ReplayDispatch,
  id: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<ReplayVisibility | null> {
  const remainingMs = deadline - Date.now();
  if (remainingMs < 0) return null;
  return new Promise<ReplayVisibility | null>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (value: ReplayVisibility | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Date.now() <= deadline ? value : null);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      fail(
        new ReplayDispatchError(
          'RUNNER_TIMEOUT',
          'React-tree replay exceeded its execution deadline',
        ),
      );
    };
    const armDeadline = (): void => {
      const nextRemainingMs = deadline - Date.now();
      timer = setTimeout(
        () => (Date.now() >= deadline ? finish(null) : armDeadline()),
        Math.min(Math.max(0, nextRemainingMs), MAX_TIMER_DELAY_MS),
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    armDeadline();
    Promise.resolve()
      .then(() => dispatch.visibility(id))
      .then(finish, (error: unknown) => {
        if (settled) return;
        if (Date.now() > deadline) {
          finish(null);
          return;
        }
        fail(error);
      });
  });
}

function refuseUnsupportedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unsupported.length > 0) {
    throw new UnsupportedStepError(`${label} (unsupported keys: ${unsupported.sort().join(', ')})`);
  }
}

export function normalizeSteps(body: unknown[], params: Record<string, string>): ReplayStep[] {
  const out: ReplayStep[] = [];
  for (const raw of body) {
    if (raw === 'waitForAnimationToEnd') {
      out.push({ t: 'wait', timeoutMs: 400 });
      continue;
    }
    if (!isObj(raw))
      throw new UnsupportedStepError(typeof raw === 'string' ? raw : `non-object(${typeof raw})`);
    const keys = Object.keys(raw);
    if (keys.length !== 1) throw new UnsupportedStepError(keys.join('+') || 'empty');
    const key = keys[0];
    const v = raw[key];
    switch (key) {
      case 'launchApp': {
        // GH #580: `simctl launch` cannot clear state (that needs uninstall +
        // reinstall), so an unhonorable key must refuse, not silently drop.
        if (isObj(v)) {
          const unsupported = Object.keys(v).filter((k) => k !== 'stopApp');
          if (unsupported.length > 0)
            throw new UnsupportedStepError(
              `launchApp (unsupported keys: ${unsupported.sort().join(', ')})`,
            );
          // A non-boolean stopApp would coerce to false — different launch
          // semantics than the author wrote, which is the same silent lie.
          if ('stopApp' in v && typeof v.stopApp !== 'boolean')
            throw new UnsupportedStepError('launchApp (stopApp must be a boolean)');
        }
        out.push({ t: 'launch', stopApp: isObj(v) && v.stopApp === true });
        break;
      }
      case 'tapOn': {
        if (isObj(v)) refuseUnsupportedKeys(v, ['id'], 'tapOn');
        const id = isObj(v) ? asString(v.id) : null;
        if (!id) throw new UnsupportedStepError('tapOn (missing string id)');
        out.push({ t: 'tap', id: interp(id, params) });
        break;
      }
      case 'inputText': {
        const text = asString(v);
        if (text === null) throw new UnsupportedStepError('inputText (value not a string)');
        out.push({ t: 'type', text: interp(text, params) });
        break;
      }
      case 'assertVisible': {
        if (isObj(v)) refuseUnsupportedKeys(v, ['id'], 'assertVisible');
        const id = isObj(v) ? asString(v.id) : null;
        if (!id) throw new UnsupportedStepError('assertVisible (missing string id)');
        out.push({
          t: 'waitVisible',
          id: interp(id, params),
          timeoutMs: DEFAULT_VISIBILITY_TIMEOUT_MS,
          evidenceType: 'assert',
        });
        break;
      }
      case 'extendedWaitUntil': {
        if (isObj(v)) refuseUnsupportedKeys(v, ['visible', 'timeout'], 'extendedWaitUntil');
        if (isObj(v) && isObj(v.visible)) {
          refuseUnsupportedKeys(v.visible, ['id'], 'extendedWaitUntil.visible');
        }
        const id = isObj(v) && isObj(v.visible) ? asString(v.visible.id) : null;
        const timeoutMs = isObj(v) && 'timeout' in v ? v.timeout : DEFAULT_VISIBILITY_TIMEOUT_MS;
        if (!id || typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
          throw new UnsupportedStepError(
            'extendedWaitUntil (need visible.id; timeout must be finite and non-negative when present)',
          );
        out.push({ t: 'waitVisible', id: interp(id, params), timeoutMs });
        break;
      }
      case 'waitForAnimationToEnd': {
        if (v === null || v === undefined) {
          out.push({ t: 'wait', timeoutMs: 400 });
          break;
        }
        if (!isObj(v)) {
          throw new UnsupportedStepError('waitForAnimationToEnd (value must be an object)');
        }
        refuseUnsupportedKeys(v, ['timeout'], 'waitForAnimationToEnd');
        if (!Number.isSafeInteger(v.timeout) || Number(v.timeout) < 0) {
          throw new UnsupportedStepError(
            'waitForAnimationToEnd (need non-negative integer timeout)',
          );
        }
        out.push({ t: 'wait', timeoutMs: Number(v.timeout) });
        break;
      }
      case 'runFlow': {
        if (isObj(v)) refuseUnsupportedKeys(v, ['when', 'commands'], 'runFlow');
        if (isObj(v) && isObj(v.when)) refuseUnsupportedKeys(v.when, ['visible'], 'runFlow.when');
        if (isObj(v) && isObj(v.when) && isObj(v.when.visible)) {
          refuseUnsupportedKeys(v.when.visible, ['id'], 'runFlow.when.visible');
        }
        const when =
          isObj(v) && isObj(v.when) && isObj(v.when.visible) ? asString(v.when.visible.id) : null;
        const commands = isObj(v) ? v.commands : undefined;
        if (!when || !Array.isArray(commands))
          throw new UnsupportedStepError('runFlow (need when.visible.id + commands[])');
        out.push({
          t: 'runFlow',
          whenVisible: interp(when, params),
          commands: normalizeSteps(commands, params),
        });
        break;
      }
      default:
        throw new UnsupportedStepError(key);
    }
  }
  return out;
}

export async function replayFlow(
  steps: ReplayStep[],
  dispatch: ReplayDispatch,
  opts: {
    indexOffset?: number;
    sourceIndex?: number;
    signal?: AbortSignal;
    initialFocusId?: string;
  } = {},
): Promise<ReplayResult> {
  const offset = opts.indexOffset ?? 0;
  const trace: ReplayResult['steps'] = [];
  let lastTapped: string | null = opts.initialFocusId ?? null;
  let pendingDesignation: { id: string; token: string; index: number } | null = null;
  let staleDesignation: { id: string; index: number } | null = null;
  let consumedDesignationId: string | null = null;
  const sourceIndex = (i: number): number => opts.sourceIndex ?? i + offset;

  const fail = (
    i: number,
    reason: string,
    failureCode?: string,
    failureMeta?: Record<string, unknown>,
  ): ReplayResult => ({
    passed: false,
    failedStepIndex: sourceIndex(i),
    ...(failureCode ? { failureCode } : {}),
    ...(failureMeta ? { failureMeta } : {}),
    reason,
    steps: trace,
  });

  const requireNotAborted = (): void => {
    if (opts.signal?.aborted) {
      throw new ReplayDispatchError(
        'RUNNER_TIMEOUT',
        'React-tree replay exceeded its execution deadline',
      );
    }
  };
  const releaseDesignation = async (token: string): Promise<void> => {
    try {
      await dispatch.releaseDesignation?.(token);
    } catch {}
  };
  const releasePendingDesignation = async (): Promise<void> => {
    const designation = pendingDesignation;
    pendingDesignation = null;
    if (designation) await releaseDesignation(designation.token);
  };

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const evidenceType = s.t === 'waitVisible' ? (s.evidenceType ?? s.t) : s.t;
    const startedAt = Date.now();
    let stepFocusOnly: true | undefined;
    if (pendingDesignation && s.t !== 'type') {
      staleDesignation = staleDesignation ?? {
        id: pendingDesignation.id,
        index: pendingDesignation.index,
      };
      const staleToken = pendingDesignation.token;
      pendingDesignation = null;
      await releaseDesignation(staleToken);
    }
    try {
      requireNotAborted();
      switch (s.t) {
        case 'launch':
          await dispatch.launch(s.stopApp);
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          break;
        case 'tap':
          const pressResult = await dispatch.press(s.id);
          if (pressResult?.kind === 'designation') {
            lastTapped = null;
            pendingDesignation = { id: s.id, token: pressResult.token, index: i };
            stepFocusOnly = true;
          } else {
            lastTapped = s.id;
          }
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            target: s.id,
            ...(stepFocusOnly ? { focusOnly: stepFocusOnly } : {}),
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          break;
        case 'type': {
          const designation = pendingDesignation;
          const target = designation?.id ?? lastTapped;
          if (!target)
            return fail(
              i,
              consumedDesignationId
                ? `the TextInput designation for "${consumedDesignationId}" was already consumed — tapOn the field again before typing`
                : 'inputText before any tapOn — no focus target',
            );
          pendingDesignation = null;
          if (designation) consumedDesignationId = designation.id;
          try {
            await dispatch.type(
              target,
              s.text,
              designation
                ? {
                    focusOnlyDesignation: true,
                    designationToken: designation.token,
                  }
                : undefined,
            );
          } finally {
            if (designation) await releaseDesignation(designation.token);
          }
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            target,
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          break;
        }
        case 'waitVisible': {
          const deadline = startedAt + s.timeoutMs;
          let verdict: ReplayVisibility | null = null;
          for (;;) {
            const observed = await readVisibilityBeforeDeadline(
              dispatch,
              s.id,
              deadline,
              opts.signal,
            );
            requireNotAborted();
            if (!observed) break;
            verdict = observed;
            if (verdict.visible) break;
            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) break;
            await new Promise<void>((resolve) =>
              setTimeout(resolve, Math.min(VISIBILITY_POLL_INTERVAL_MS, remainingMs)),
            );
          }
          const waitedMs = Date.now() - startedAt;
          trace.push({
            sourceIndex: sourceIndex(i),
            t: evidenceType,
            target: s.id,
            ok: verdict?.visible === true,
            durationMs: waitedMs,
          });
          if (!verdict)
            return fail(
              i,
              `waitVisible: no readable visibility observation completed for "${s.id}" before the deadline`,
              'RUNNER_TIMEOUT',
              { failedSelector: s.id, waitedMs },
            );
          if (!verdict.visible)
            return fail(
              i,
              verdict.reason ?? `waitVisible: "${s.id}" is not frontmost`,
              verdict.code ?? 'TESTID_NOT_FOUND',
              { ...verdict.meta, failedSelector: s.id, waitedMs },
            );
          break;
        }
        case 'wait':
          await dispatch.settle(s.timeoutMs);
          requireNotAborted();
          trace.push({
            sourceIndex: sourceIndex(i),
            t: s.t,
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          break;
        case 'runFlow': {
          const condition = await dispatch.visibility(s.whenVisible);
          requireNotAborted();
          if (condition.visible) {
            const sub = await replayFlow(s.commands, dispatch, {
              sourceIndex: sourceIndex(i),
              signal: opts.signal,
              initialFocusId: lastTapped ?? undefined,
            });
            requireNotAborted();
            trace.push(...sub.steps);
            if (!sub.passed) {
              return {
                passed: false,
                failedStepIndex: sourceIndex(i),
                ...(sub.failureCode ? { failureCode: sub.failureCode } : {}),
                ...(sub.failureMeta ? { failureMeta: sub.failureMeta } : {}),
                reason: sub.reason,
                steps: trace,
              };
            }
            lastTapped = sub.finalFocusId ?? null;
          } else if (condition.code && condition.code !== 'TESTID_NOT_FOUND') {
            return fail(
              i,
              condition.reason ?? `runFlow condition proof failed for "${s.whenVisible}"`,
              condition.code,
              condition.meta,
            );
          } else {
            trace.push({
              sourceIndex: sourceIndex(i),
              t: s.t,
              target: s.whenVisible,
              ok: true,
              durationMs: Date.now() - startedAt,
            });
          }
          break;
        }
      }
    } catch (e) {
      const waitedMs = Date.now() - startedAt;
      await releasePendingDesignation();
      trace.push({
        sourceIndex: sourceIndex(i),
        t: evidenceType,
        target: 'id' in s ? s.id : undefined,
        ...(stepFocusOnly ? { focusOnly: stepFocusOnly } : {}),
        ok: false,
        durationMs: waitedMs,
      });
      const dispatchMeta = e instanceof ReplayDispatchError ? e.meta : undefined;
      return fail(
        i,
        e instanceof Error ? e.message : String(e),
        e instanceof ReplayDispatchError ? e.code : undefined,
        s.t === 'waitVisible' ? { ...dispatchMeta, failedSelector: s.id, waitedMs } : dispatchMeta,
      );
    }
  }

  if (opts.signal?.aborted) {
    await releasePendingDesignation();
    return fail(
      Math.max(0, steps.length - 1),
      'React-tree replay exceeded its execution deadline',
      'RUNNER_TIMEOUT',
    );
  }
  const unconsumedDesignation = staleDesignation ?? pendingDesignation;
  if (unconsumedDesignation) {
    if (pendingDesignation) {
      await releasePendingDesignation();
    }
    return fail(
      unconsumedDesignation.index,
      `TextInput designation for "${unconsumedDesignation.id}" must be followed immediately by inputText`,
      'INTERACTION_NOT_ACTUATED',
      { failedSelector: unconsumedDesignation.id, focusOnly: true },
    );
  }
  return { passed: true, finalFocusId: lastTapped, steps: trace };
}
