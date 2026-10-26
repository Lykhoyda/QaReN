import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, readMetrics } from '../../calibration/analyze.ts';
import { command, analyzeRun } from '../../calibration/run.ts';
import { schedule, target } from '../../calibration/schedule.ts';
import {
  TIMING_PREFIX,
  type RecordedTimingEvent,
  type TimingEvent,
} from '../../../dist/qa/timing.js';
import type { Ledger } from '../../../dist/qa/ledger.js';

function syntheticCampaign() {
  const events: RecordedTimingEvent[] = [];
  const manifest = schedule();
  let observation = 0;
  let line = 0;
  const point = (stage: TimingEvent['stage'], extra: Partial<TimingEvent> = {}) =>
    events.push({
      v: 1,
      seq: events.length + 1,
      stage,
      edge: 'point',
      outcome: 'ok',
      at: 0,
      line,
      observation,
      ...extra,
    });
  const span = (stage: TimingEvent['stage'], body = () => {}, extra: Partial<TimingEvent> = {}) => {
    point(stage, { edge: 'start', ...extra });
    body();
    point(stage, { edge: 'end', ms: 0, ...extra });
  };
  const capture = () => {
    observation++;
    span(
      'capture',
      () => {
        for (const stage of [
          'native-total',
          'native-transport',
          'native-decode',
          'react-private',
          'join-private',
        ] as const)
          span(stage);
        span('native-readiness', () => {}, { count: 1 });
        span('native-readiness', () => {}, { count: 2 });
        point('native-read-only-v1', { count: 1 });
        point('native-read-only-v1', { count: 2 });
        point('native-presence-v2', { budgetMs: 20_000, appliedBudgetMs: 20_000 });
        for (const stage of [
          'native-production',
          'native-initial-eligibility',
          'native-enumeration',
          'native-observation',
          'native-final-eligibility',
          'native-revalidation',
          'privacy-history',
        ] as const)
          point(stage, { ms: 0 });
      },
      { presence: 1 },
    );
  };
  point('walk', { edge: 'start' });
  for (line of manifest.lines) {
    const cycle = manifest.cycles.find((c) => c.line === line);
    if (cycle?.kind !== 'cached-press') capture();
    span(
      'decision',
      () => {
        if (cycle?.kind === 'cached-press') point('cache-reuse');
        else span('jev-attempt', () => span('jev-validation'));
      },
      {
        useMs: 0,
        ageMs: 0,
        ...(line === manifest.cachedCheck
          ? { nextLine: manifest.cycles.find((c) => c.kind === 'cached-press')!.line }
          : {}),
      },
    );
    if (cycle || manifest.items.find((i) => i.line === line)?.kind === 'press') {
      span('mutation', () => point('authorization', { ms: 0, useMs: 0, ageMs: 0, count: 1 }), {
        count: 1,
      });
      capture();
      point('readback', { useMs: 0, ageMs: 0 });
    }
    span('screenshot');
  }
  point('walk', { edge: 'end', line: 0, observation: 0, ms: 0 });
  const ledger: Ledger = {
    verdict: 'PASS',
    path: 'walk',
    llmTurns: 0,
    escapes: 0,
    recoveries: 0,
    blocks: [],
    jev: { calls: 0, medianMs: 0, inputTokens: 0, callDetails: [] },
    steps: manifest.lines.map((line) => ({
      block: 'synthetic',
      line,
      text: '',
      attempt: 1,
      kind: 'step',
      resolvedBy: 'jev',
      t: 0,
      outcome: 'pass',
    })),
  };
  return { events, ledger };
}

test('fixed schedule contains all cohorts, guarded paths and only the ordinary CLI command', () => {
  const manifest = schedule();
  assert.deepEqual(
    manifest.acquisitions.map((g) => g.lines.length),
    [5, 5, 5],
  );
  assert.ok(manifest.cycles.length >= 5);
  assert.deepEqual(
    new Set(manifest.cycles.map((c) => c.kind)),
    new Set(['press', 'cached-press', 'fill', 'scroll']),
  );
  assert.equal(command()[0], 'check');
  assert.ok(command().includes(target.device));
  assert.ok(!command().some((arg) => /runtime|budget|timeout/.test(arg)));
});

test('synthetic complete metric contract is analyzable, with no live acceptance claim', () => {
  const { events, ledger } = syntheticCampaign();
  assert.deepEqual(analyze(events, ledger).failures, []);
});

test('each missing adapter measurement fails even with a functional PASS ledger', () => {
  for (const stage of [
    'native-readiness',
    'native-transport',
    'native-decode',
    'native-read-only-v1',
  ] as const) {
    const { events, ledger } = syntheticCampaign();
    const result = analyze(
      events.filter((e) => e.stage !== stage),
      ledger,
    );
    assert.equal(result.pass, false, stage);
    assert.ok(result.failures.includes(`MISSING_${stage.toUpperCase().replaceAll('-', '_')}`));
  }
});

test('truncated, malformed, gapped, nonmonotonic or content-bearing metric streams refuse', () => {
  const event = { v: 1, seq: 1, stage: 'walk', edge: 'start', outcome: 'ok', at: 1 };
  assert.equal(readMetrics(`${TIMING_PREFIX}${JSON.stringify(event)}\n`).length, 1);
  for (const text of [
    '{',
    JSON.stringify({ ...event, seq: 2 }),
    JSON.stringify({ ...event, prompt: 'SECRET' }),
    `${JSON.stringify(event)}\n${TIMING_PREFIX}${JSON.stringify({ ...event, seq: 2, at: 0 })}`,
  ])
    assert.throws(() => readMetrics(`${TIMING_PREFIX}${text}`));
  const { events, ledger } = syntheticCampaign();
  assert.equal(analyze(events.slice(0, -1), ledger).pass, false);
  assert.equal(analyze([], ledger).pass, false);
});

test('all timing margins, cached screenshots, missing cases and replay are enforced', () => {
  const mutations: [(e: RecordedTimingEvent[]) => void, string][] = [
    [
      (e) => {
        e.find((x) => x.stage === 'native-production')!.ms = 18_001;
      },
      'NATIVE_HEADROOM',
    ],
    [
      (e) => {
        e.find((x) => x.stage === 'capture' && x.edge === 'end')!.ms = 20_001;
      },
      'ACQUISITION_HEADROOM',
    ],
    [
      (e) => {
        e.find((x) => x.stage === 'authorization')!.useMs = 8_001;
      },
      'USE_HEADROOM',
    ],
    [
      (e) => {
        e.find((x) => x.stage === 'authorization')!.ageMs = 32_000;
      },
      'OLDEST_EVIDENCE',
    ],
    [
      (e) => {
        e.find((x) => x.stage === 'cache-reuse')!.stage = 'refresh';
      },
      'REFRESH_EXPIRY_OR_REPLAY',
    ],
    [
      (e) => {
        e.find((x) => x.stage === 'cache-reuse')!.stage = 'replay';
      },
      'REFRESH_EXPIRY_OR_REPLAY',
    ],
    [
      (e) => {
        e.find(
          (x) => x.stage === 'screenshot' && x.line === schedule().cachedCheck && x.edge === 'end',
        )!.outcome = 'withheld';
      },
      'CACHED_SCREENSHOT_PATH_MISSING',
    ],
    [
      (e) => {
        const line = schedule().acquisitions[1].lines[2];
        e.splice(0, e.length, ...e.filter((x) => x.line !== line));
      },
      'ACQUISITION_COHORT_MISSING',
    ],
  ];
  for (const [mutate, expected] of mutations) {
    const { events, ledger } = syntheticCampaign();
    mutate(events);
    assert.ok(analyze(events, ledger).failures.includes(expected), expected);
  }
  const { events, ledger } = syntheticCampaign();
  ledger.steps.pop();
  const result = analyze(events, ledger);
  assert.ok(result.failures.includes('SCHEDULE_NOT_COMPLETE'));
  assert.equal(result.cases.at(-1)?.functionalOutcome, 'missing');
});

test('an absent campaign is explicitly incomplete and never starts a run', () => {
  const result = analyzeRun('/nonexistent-qaren-calibration-test');
  assert.equal(result.pass, false);
  assert.deepEqual(result.failures, ['CAMPAIGN_EVIDENCE_MISSING_OR_INVALID']);
  assert.equal(result.expected.lines.length, schedule().lines.length);
});
