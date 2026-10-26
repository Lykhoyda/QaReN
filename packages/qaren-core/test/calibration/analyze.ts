import {
  cleanTimingEvent,
  TIMING_EVENT_LIMIT,
  TIMING_PREFIX,
  type RecordedTimingEvent,
  type TimingStage,
} from '../../dist/qa/timing.js';
import type { WalkResult } from '../../dist/qa/ledger.js';
import { policy, schedule } from './schedule.ts';

export interface CalibrationAnalysis {
  pass: boolean;
  failures: string[];
  counts: {
    captures: number;
    authorizations: number;
    refreshes: number;
    replays: number;
    reasks: number;
  };
  maxima: { nativeMs: number; acquisitionMs: number; useMs: number; oldestMs: number };
  cases: {
    line: number;
    functionalOutcome: 'pass' | 'fail' | 'missing';
    captures: number;
    authorizations: number;
  }[];
}

export function readMetrics(log: string): RecordedTimingEvent[] {
  if (Buffer.byteLength(log) > 32 * 1024 * 1024) throw new Error('CALIBRATION_LOG_LIMIT');
  const events: RecordedTimingEvent[] = [];
  for (const line of log.split('\n')) {
    if (!line.startsWith(TIMING_PREFIX)) continue;
    if (line.length > 2048 || events.length > TIMING_EVENT_LIMIT)
      throw new Error('CALIBRATION_METRICS_INVALID');
    const value = JSON.parse(line.slice(TIMING_PREFIX.length));
    const event = cleanTimingEvent(value);
    if (
      !event ||
      value.v !== 1 ||
      value.seq !== events.length + 1 ||
      Object.keys(value).some((key) => !['v', 'seq', ...Object.keys(event)].includes(key)) ||
      (events.length > 0 && event.at < events.at(-1)!.at)
    )
      throw new Error('CALIBRATION_METRICS_INVALID');
    events.push({ ...event, v: 1, seq: value.seq });
  }
  return events;
}

export function analyze(events: RecordedTimingEvent[], ledger: WalkResult): CalibrationAnalysis {
  const failures = new Set<string>();
  const fail = (code: string) => failures.add(code);
  const manifest = schedule();
  const select = (stage: TimingStage, edge: RecordedTimingEvent['edge'] = 'point') =>
    events.filter((e) => e.stage === stage && e.edge === edge);
  const captures = select('capture', 'end');
  const authorizations = select('authorization');
  const counts = {
    captures: captures.length,
    authorizations: authorizations.length,
    refreshes: select('refresh').length,
    replays: select('replay').length,
    reasks: select('reask').length,
  };
  const maxima = { nativeMs: 0, acquisitionMs: 0, useMs: 0, oldestMs: 0 };
  if (
    ledger.verdict !== 'PASS' ||
    ledger.llmTurns !== 0 ||
    ledger.escapes !== 0 ||
    ledger.recoveries !== 0
  )
    fail('WALK_NOT_BASELINE_PASS');
  if (
    JSON.stringify(ledger.steps.map((s) => s.line)) !== JSON.stringify(manifest.lines) ||
    ledger.steps.some((s) => s.outcome !== 'pass' || s.attempt !== 1)
  )
    fail('SCHEDULE_NOT_COMPLETE');
  if (counts.refreshes || counts.replays || select('expiry').length)
    fail('REFRESH_EXPIRY_OR_REPLAY');
  if (events.some((e) => e.outcome === 'failed' || e.outcome === 'unknown'))
    fail('FAILED_OR_UNKNOWN_MEASUREMENT');
  if (
    select('walk', 'start').length !== 1 ||
    select('walk', 'end').length !== 1 ||
    events[0]?.stage !== 'walk' ||
    events.at(-1)?.stage !== 'walk'
  )
    fail('INCOMPLETE_STREAM');
  const open = new Map<string, RecordedTimingEvent>();
  const successfulStarts = new Map<number, RecordedTimingEvent>();
  for (const event of events) {
    const key = `${event.stage}:${event.line ?? 0}:${event.observation ?? 0}`;
    if (event.edge === 'start') {
      if (open.has(key)) fail('OVERLAPPING_SPAN');
      open.set(key, event);
    } else if (event.edge === 'end') {
      const start = open.get(key);
      if (
        !start ||
        event.ms === undefined ||
        event.at < start.at ||
        Math.abs(event.ms - (event.at - start.at)) > 2
      )
        fail('UNPAIRED_SPAN');
      else if (start.outcome === 'ok' && event.outcome === 'ok')
        successfulStarts.set(event.seq, start);
      open.delete(key);
    }
  }
  if (open.size) fail('UNFINISHED_SPAN');
  const hasValidatedDecision = (
    start?: RecordedTimingEvent,
    end?: RecordedTimingEvent,
  ): boolean => {
    if (!start || !end || successfulStarts.get(end.seq) !== start) return false;
    const attempts = select('jev-attempt', 'end').filter(
      (e) => start.seq < e.seq && e.seq < end.seq,
    );
    return (
      attempts.length > 0 &&
      attempts.every((attempt) => {
        const attemptStart = successfulStarts.get(attempt.seq);
        return (
          attemptStart &&
          attemptStart.seq > start.seq &&
          attemptStart.count === attempt.count &&
          select('jev-validation', 'end').some((validation) => {
            const validationStart = successfulStarts.get(validation.seq);
            return (
              validationStart &&
              validationStart.seq > attemptStart.seq &&
              validation.seq < attempt.seq
            );
          })
        );
      })
    );
  };
  if (!captures.length) fail('CAPTURES_MISSING');
  const required: TimingStage[] = [
    'native-total',
    'react-private',
    'join-private',
    'privacy-history',
    'native-readiness',
    'native-transport',
    'native-decode',
  ];
  for (const capture of captures) {
    if (!capture.observation || capture.ms === undefined) {
      fail('CAPTURE_ID_OR_DURATION_MISSING');
      continue;
    }
    maxima.acquisitionMs = Math.max(maxima.acquisitionMs, capture.ms);
    if (capture.ms > policy.acquisitionMs) fail('ACQUISITION_HEADROOM');
    const same = events.filter((e) => e.observation === capture.observation && e.edge !== 'start');
    for (const stage of required)
      if (!same.some((e) => e.stage === stage && e.ms !== undefined && e.outcome === 'ok'))
        fail(`MISSING_${stage.toUpperCase().replaceAll('-', '_')}`);
    const readiness = same.filter((e) => e.stage === 'native-readiness');
    const probes = capture.presence === 1 ? [1, 2] : [1];
    if (
      readiness.length !== probes.length ||
      !probes.every((n) =>
        readiness.some((e) => e.count === n && e.edge === 'end' && e.ms !== undefined),
      )
    )
      fail('READINESS_PROBES_INCOMPLETE');
    if (
      !probes.every((count) =>
        same.some(
          (e) =>
            e.stage === 'native-read-only-v1' &&
            e.edge === 'point' &&
            e.count === count &&
            e.outcome === 'ok',
        ),
      )
    )
      fail('MISSING_NATIVE_READ_ONLY_V1');
    if (capture.presence === 1) {
      if (
        !same.some(
          (e) =>
            e.stage === 'native-presence-v2' &&
            e.outcome === 'ok' &&
            e.budgetMs === 20_000 &&
            e.appliedBudgetMs === e.budgetMs,
        )
      )
        fail('NATIVE_PRESENCE_CONTRACT_MISSING');
      for (const stage of [
        'native-production',
        'native-initial-eligibility',
        'native-enumeration',
        'native-observation',
        'native-final-eligibility',
        'native-revalidation',
      ] as const) {
        const samples = same.filter(
          (e) => e.stage === stage && e.ms !== undefined && e.outcome === 'ok',
        );
        if (samples.length !== 1) fail(`MISSING_${stage.toUpperCase().replaceAll('-', '_')}`);
        if (stage === 'native-production' && samples[0]) {
          maxima.nativeMs = Math.max(maxima.nativeMs, samples[0].ms!);
          if (samples[0].ms! > policy.nativeMs) fail('NATIVE_HEADROOM');
        }
      }
    }
  }
  if (new Set(captures.map((c) => c.observation)).size !== captures.length)
    fail('DUPLICATE_OBSERVATION');
  for (const item of manifest.items) {
    const observations = events.filter(
      (e) => e.line === item.line && (e.stage === 'capture' || e.stage === 'cache-reuse'),
    );
    if (!observations.length) fail('SCHEDULED_OBSERVATION_MISSING');
    if (
      !events.some(
        (e) =>
          e.line === item.line &&
          e.stage === 'screenshot' &&
          (e.edge === 'end' || e.outcome === 'withheld'),
      )
    )
      fail('SCHEDULED_SCREENSHOT_MISSING');
    if (item.kind === 'wait' || item.kind === 'check') {
      if (!select('decision', 'end').some((e) => e.line === item.line))
        fail('SCHEDULED_DECISION_MISSING');
    } else if (
      !authorizations.some((e) => e.line === item.line) ||
      !select('mutation', 'end').some((e) => e.line === item.line) ||
      !select('readback').some((e) => e.line === item.line)
    )
      fail('SCHEDULED_MUTATION_MISSING');
  }
  for (const group of manifest.acquisitions) {
    const cohort = captures.filter((c) => group.lines.includes(c.line!));
    if (
      cohort.length < 5 ||
      group.lines.some((line) => !cohort.some((c) => c.line === line && c.presence === 1))
    )
      fail('ACQUISITION_COHORT_MISSING');
    const indexes = cohort.map((c) => captures.indexOf(c));
    if (indexes.some((index, i) => i > 0 && index !== indexes[i - 1] + 1))
      fail('ACQUISITIONS_NOT_CONSECUTIVE');
    for (const c of cohort) {
      const start = select('decision', 'start').find(
        (d) => d.observation === c.observation && d.line === c.line,
      );
      const end = select('decision', 'end').find(
        (d) => d.observation === c.observation && d.line === c.line && d.outcome === 'ok',
      );
      if (!hasValidatedDecision(start, end)) fail('PROJECTION_USE_MISSING');
    }
  }
  for (const use of [...select('decision', 'end'), ...select('readback'), ...authorizations]) {
    if (use.outcome !== 'ok') continue;
    if (
      use.useMs === undefined ||
      use.ageMs === undefined ||
      !captures.some((c) => c.observation === use.observation && c.at <= use.at)
    ) {
      fail('USE_TIMING_MISSING');
      continue;
    }
    maxima.useMs = Math.max(maxima.useMs, use.useMs);
    maxima.oldestMs = Math.max(maxima.oldestMs, use.ageMs);
    if (use.useMs > policy.useMs) fail('USE_HEADROOM');
    if (use.ageMs >= policy.oldestMs) fail('OLDEST_EVIDENCE');
  }
  for (const mutation of select('mutation', 'end')) {
    const start = successfulStarts.get(mutation.seq);
    const sends = authorizations.filter(
      (e) => e.seq > (start?.seq ?? Infinity) && e.seq < mutation.seq,
    );
    if (
      !start ||
      !sends.length ||
      sends.length !== mutation.count ||
      sends.some(
        (e, i) =>
          e.count !== i + 1 ||
          e.ms === undefined ||
          e.outcome !== 'ok' ||
          e.line !== mutation.line ||
          e.observation !== mutation.observation,
      )
    )
      fail('AUTHORIZATION_ACCOUNTING');
    const readback = select('readback').find(
      (e) => e.line === mutation.line && e.seq > mutation.seq,
    );
    const capture = readback && captures.find((c) => c.observation === readback.observation);
    const captureStart = capture && successfulStarts.get(capture.seq);
    if (
      !readback ||
      readback.outcome !== 'ok' ||
      !capture ||
      !captureStart ||
      capture.line !== mutation.line ||
      captureStart.seq <= mutation.seq ||
      capture.seq >= readback.seq
    )
      fail('READBACK_MISSING');
  }
  for (const cycle of manifest.cycles) {
    const sends = authorizations.filter((e) => e.line === cycle.line);
    if (!sends.length) {
      fail('SCHEDULED_DISPATCH_MISSING');
      continue;
    }
    if (!select('mutation', 'end').some((e) => e.line === cycle.line && e.outcome === 'ok'))
      fail('MUTATION_COMPLETION_MISSING');
    const observation = sends[0].observation;
    const decision = select('decision', 'start').find(
      (d) => d.observation === observation && (d.line === cycle.line || d.nextLine === cycle.line),
    );
    const end =
      decision &&
      select('decision', 'end').find(
        (d) => d.observation === observation && d.line === decision.line && d.seq > decision.seq,
      );
    if (cycle.model && !hasValidatedDecision(decision, end)) fail('LIVE_DECISION_CYCLE_MISSING');
    if (cycle.model && !ledger.steps.some((s) => s.line === cycle.line && s.resolvedBy === 'jev'))
      fail('JEV_RESOLVED_ROW_MISSING');
    if (cycle.kind === 'cached-press') {
      const reuse = select('cache-reuse').find(
        (e) => e.line === cycle.line && e.observation === observation,
      );
      const shot = select('screenshot', 'end').find(
        (e) =>
          e.line === manifest.cachedCheck && e.observation === observation && e.outcome === 'ok',
      );
      if (
        !reuse ||
        !shot ||
        !end ||
        !(end.seq < shot.seq && shot.seq < reuse.seq && reuse.seq < sends[0].seq)
      )
        fail('CACHED_SCREENSHOT_PATH_MISSING');
    }
  }
  const cases: CalibrationAnalysis['cases'] = manifest.lines.map((line) => {
    const rows = ledger.steps.filter((row) => row.line === line);
    return {
      line,
      functionalOutcome:
        rows.length === 0
          ? 'missing'
          : rows.every((row) => row.outcome === 'pass')
            ? 'pass'
            : 'fail',
      captures: captures.filter((e) => e.line === line).length,
      authorizations: authorizations.filter((e) => e.line === line).length,
    };
  });
  return { pass: failures.size === 0, failures: [...failures], counts, maxima, cases };
}
