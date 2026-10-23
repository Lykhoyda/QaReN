import { isRecord } from './questions.js';
import type { CDPClient } from '../cdp-client.js';
import type { ReactObservation } from './capture.js';
import { isReactCaptureCause, ReactCaptureIncomplete } from './private-input.js';
import { validateReactHostEvidence } from './screen.js';
import type { DigestEntry } from './screen.js';

const PRODUCER_DIAGNOSTIC = [
  'cause',
  'scanned',
  'budget',
  'roots',
  'hosts',
  'interactive',
  'queued',
  'pruned',
];
const VERDICT_REASONS = [
  'no-renderer',
  'renderer-error',
  'root-enumeration-incomplete',
  'renderers-unscanned',
  'scan-budget-exhausted',
  'output-truncated',
];

// The producer's refusal carries only a fixed cause and integer counters.
function producerRefusal(diagnostic: unknown): ReactCaptureIncomplete {
  if (
    !isRecord(diagnostic) ||
    Object.keys(diagnostic).some((key) => !PRODUCER_DIAGNOSTIC.includes(key)) ||
    !isReactCaptureCause(diagnostic.cause)
  )
    return new ReactCaptureIncomplete('completion-shape');
  return new ReactCaptureIncomplete(diagnostic.cause, diagnostic);
}

function completion(value: unknown, id?: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{1,64}$/.test(value.id) ||
    (id !== undefined && value.id !== id) ||
    (value.state !== 'pending' && value.state !== 'ready' && value.state !== 'refused') ||
    Object.keys(value).some(
      (key) => !['v', 'id', 'state', 'tree', 'reason', 'diagnostic'].includes(key),
    ) ||
    (value.diagnostic !== undefined && (value.state !== 'refused' || value.reason !== undefined)) ||
    (value.state !== 'ready' && value.tree !== undefined)
  ) {
    throw new ReactCaptureIncomplete('completion-shape');
  }
  if ((value.state === 'refused') !== (value.reason === 'render-error')) {
    throw value.state === 'refused' && value.reason === undefined
      ? producerRefusal(value.diagnostic)
      : new ReactCaptureIncomplete('completion-shape');
  }
  return value;
}

function verdictReasons(verdict: unknown): string {
  const reasons = new Set<string>();
  if (isRecord(verdict)) {
    if (Array.isArray(verdict.reasons))
      for (const reason of verdict.reasons)
        reasons.add(
          typeof reason === 'string' && VERDICT_REASONS.includes(reason) ? reason : 'unrecognized',
        );
    else if (verdict.reasons !== undefined) reasons.add('unrecognized');
    if (
      verdict.unscannedRendererIds !== undefined &&
      (!Array.isArray(verdict.unscannedRendererIds) || verdict.unscannedRendererIds.length !== 0)
    )
      reasons.add('unscanned-renderers');
    if (verdict.rendererErrors !== undefined && verdict.rendererErrors !== 0)
      reasons.add('renderer-errors');
    if (verdict.droppedSubtrees !== undefined && verdict.droppedSubtrees !== 0)
      reasons.add('dropped-subtrees');
    if (verdict.collapsedChildLists !== undefined && verdict.collapsedChildLists !== 0)
      reasons.add('collapsed-child-lists');
  }
  return `verdict-reasons:${[...reasons].join(',') || 'incomplete'}`;
}

function treeCounters(value: Record<string, unknown>): Record<string, unknown> {
  const verdict = isRecord(value.verdict) ? value.verdict : {};
  const hosts = isRecord(value.hostEvidence) ? value.hostEvidence.hosts : undefined;
  return {
    scanned: verdict.scannedNodes ?? value.totalNodes,
    roots: verdict.rootsSeeded ?? value.rootsSeeded,
    hosts: Array.isArray(hosts) ? hosts.length : undefined,
    interactive: Array.isArray(value.interactive) ? value.interactive.length : undefined,
  };
}

function publicObservation(tree: unknown): ReactObservation {
  if (typeof tree !== 'string') throw new ReactCaptureIncomplete('completion-shape');
  if (tree.length > 999999) throw new ReactCaptureIncomplete('tree-too-large');
  let value: unknown;
  try {
    value = JSON.parse(tree);
  } catch {
    throw new ReactCaptureIncomplete('tree-shape');
  }
  if (isRecord(value) && value.__agent_truncated === true)
    throw new ReactCaptureIncomplete('tree-too-large');
  if (!isRecord(value) || !Array.isArray(value.interactive))
    throw new ReactCaptureIncomplete('tree-shape');
  const counters = treeCounters(value);
  if (value.interactive.length > 200) throw new ReactCaptureIncomplete('interactive-cap', counters);
  if (value.truncated !== undefined && value.truncated !== false)
    throw new ReactCaptureIncomplete('truncated', counters);
  const entryShape = () => new ReactCaptureIncomplete('entry-shape', counters);
  const verdict = value.verdict;
  if (
    !isRecord(verdict) ||
    verdict.state !== 'ok' ||
    verdict.path !== 'interactive' ||
    verdict.complete !== true ||
    ['reasons', 'unscannedRendererIds'].some(
      (key) =>
        verdict[key] !== undefined && (!Array.isArray(verdict[key]) || verdict[key].length !== 0),
    ) ||
    ['rendererErrors', 'droppedSubtrees', 'collapsedChildLists'].some(
      (key) => verdict[key] !== undefined && verdict[key] !== 0,
    )
  ) {
    throw new ReactCaptureIncomplete(verdictReasons(verdict), counters);
  }
  const hostEvidence = validateReactHostEvidence(value.hostEvidence);
  if (!hostEvidence?.complete)
    throw new ReactCaptureIncomplete('host-evidence-incomplete', counters);
  const interactive: DigestEntry[] = value.interactive.map((entry: unknown) => {
    if (
      !isRecord(entry) ||
      typeof entry.role !== 'string' ||
      !/^[a-z][a-z0-9-]{0,31}$/.test(entry.role)
    ) {
      throw entryShape();
    }
    const result: DigestEntry = { role: entry.role };
    for (const key of ['testID', 'text', 'label', 'placeholder'] as const) {
      if (entry[key] !== undefined) {
        if (typeof entry[key] !== 'string') throw entryShape();
        result[key] = entry[key];
      }
    }
    if (entry.value !== undefined) {
      if (typeof entry.value !== 'boolean' || entry.role !== 'switch') throw entryShape();
      result.value = entry.value;
    }
    if (entry.disabled !== undefined) {
      if (typeof entry.disabled !== 'boolean') throw entryShape();
      result.disabled = entry.disabled;
    }
    if (entry.capabilities !== undefined) {
      if (
        !isRecord(entry.capabilities) ||
        typeof entry.capabilities.press !== 'boolean' ||
        typeof entry.capabilities.fill !== 'boolean'
      ) {
        throw entryShape();
      }
      result.capabilities = { press: entry.capabilities.press, fill: entry.capabilities.fill };
    }
    if (entry.hidden !== undefined) {
      if (entry.hidden !== true) throw entryShape();
      result.hidden = true;
    }
    if (entry.compositeWrapper !== undefined) {
      if (entry.compositeWrapper !== true) throw entryShape();
      result.compositeWrapper = true;
    }
    if (entry.inputHostIndices !== undefined) {
      if (
        !Array.isArray(entry.inputHostIndices) ||
        entry.inputHostIndices.length > hostEvidence.hosts.length ||
        entry.inputHostIndices.some(
          (index: unknown) =>
            !Number.isInteger(index) ||
            Number(index) < 0 ||
            Number(index) >= hostEvidence.hosts.length,
        )
      )
        throw entryShape();
      result.inputHostIndices = [...entry.inputHostIndices];
    }
    if (entry.handlerless !== undefined) {
      if (
        entry.handlerless !== true ||
        result.capabilities?.press !== false ||
        result.capabilities.fill !== false
      )
        throw entryShape();
      result.handlerless = true;
    }
    return result;
  });
  return {
    interactive,
    hostEvidence,
    truncated: false,
    verdict: { state: 'ok', path: 'interactive', complete: true },
  };
}

export async function captureQaReact(
  client: Pick<CDPClient, 'withPrivateHelperWorld' | 'isConnected'>,
  typography = false,
): Promise<ReactObservation> {
  const started = performance.now();
  const deadline = started + 1500;
  let expired = false;
  // The helper world rewraps operation errors, so the classified refusal is kept aside.
  let refusal: ReactCaptureIncomplete | undefined;
  const remaining = (): number => {
    const ms = deadline - performance.now();
    if (expired || ms <= 0) throw new ReactCaptureIncomplete('deadline');
    return ms;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const observation = await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new ReactCaptureIncomplete('deadline'));
        }, remaining());
      }),
      client.withPrivateHelperWorld(async (evaluate) => {
        try {
          const start = completion(
            await evaluate(
              `globalThis.__QAREN.beginQaCapture(${typography === true ? 'true' : 'false'})`,
              remaining(),
            ),
          );
          remaining();
          const id = start.id as string;
          let current = start;
          while (current.state === 'pending') {
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining())));
            current = completion(
              await evaluate(
                `globalThis.__QAREN.readQaCapture(${JSON.stringify(id)})`,
                remaining(),
              ),
              id,
            );
            remaining();
          }
          // The producer's fixed render-error refusal carries no tree and no input values.
          const observation =
            current.state === 'refused' ? { renderError: true } : publicObservation(current.tree);
          remaining();
          return observation;
        } catch (error) {
          if (error instanceof ReactCaptureIncomplete) refusal ??= error;
          throw error;
        }
      }),
    ]);
    remaining();
    return observation;
  } catch (error) {
    const ms = Math.round(performance.now() - started);
    if (!client.isConnected) throw new ReactCaptureIncomplete('disconnected', { ms });
    const classified = error instanceof ReactCaptureIncomplete ? error : refusal;
    if (classified)
      throw new ReactCaptureIncomplete(classified.reason, { ...classified.counters, ms });
    throw new ReactCaptureIncomplete(
      performance.now() >= deadline ? 'deadline' : 'evaluate-error',
      {
        ms,
      },
    );
  } finally {
    expired = true;
    clearTimeout(timer);
  }
}
