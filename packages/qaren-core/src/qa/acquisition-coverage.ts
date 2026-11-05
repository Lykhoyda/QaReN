import { isRecord } from './questions.js';
import type { NativeObservation, ReactObservation } from './capture.js';
import type { ReactHostEvidence, Screen } from './screen.js';

type Coverage = NonNullable<Screen['coverage']>;

export function nativeCaptureCoverage(observation: NativeObservation): Coverage['native'] {
  const verdict = isRecord(observation.snapshotVerdict) ? observation.snapshotVerdict : undefined;
  if (
    observation.truncated === true ||
    (typeof observation.normalizationDroppedNodes === 'number' &&
      observation.normalizationDroppedNodes > 0) ||
    verdict?.state === 'degraded' ||
    verdict?.state === 'failed' ||
    verdict?.refMapUpdated === false ||
    (Array.isArray(verdict?.reasons) && verdict.reasons.length > 0) ||
    (Array.isArray(observation.nodes) &&
      typeof verdict?.nodeCount === 'number' &&
      (observation.nodes.length === 0 || verdict.nodeCount !== observation.nodes.length))
  )
    return 'incomplete';
  return Array.isArray(observation.nodes) &&
    observation.nodes.length > 0 &&
    observation.truncated === false &&
    observation.normalizationDroppedNodes === 0 &&
    verdict?.state === 'ok' &&
    verdict.nodeCount === observation.nodes.length &&
    verdict.refMapUpdated === true &&
    Array.isArray(verdict.reasons) &&
    verdict.reasons.length === 0
    ? 'complete'
    : 'unknown';
}

export function reactCaptureCoverage(observation: ReactObservation): Coverage['react'] {
  const verdict = isRecord(observation.verdict) ? observation.verdict : undefined;
  if (
    observation.truncated === true ||
    verdict?.state === 'failed' ||
    verdict?.state === 'degraded' ||
    verdict?.complete === false ||
    (typeof verdict?.path === 'string' && verdict.path !== 'interactive') ||
    (Array.isArray(verdict?.reasons) && verdict.reasons.length > 0)
  )
    return 'incomplete';
  return Array.isArray(observation.interactive) &&
    (observation.truncated === undefined || observation.truncated === false) &&
    verdict?.state === 'ok' &&
    verdict.path === 'interactive' &&
    verdict.complete === true
    ? 'complete'
    : 'unknown';
}

export function reactCoverage(
  observation: ReactObservation,
  acquired: Coverage['react'],
  hostEvidence: ReactHostEvidence | undefined,
): Coverage['react'] {
  if (
    acquired === 'incomplete' ||
    (observation.hostEvidence !== undefined && !hostEvidence) ||
    hostEvidence?.complete === false
  )
    return 'incomplete';
  return acquired === 'complete' && hostEvidence?.complete === true ? 'complete' : 'unknown';
}
