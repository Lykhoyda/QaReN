// D1206 Tier 2 Sprint C / Phase 127: ReusableAction entity unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  freshRuntimeState,
  appendRunRecord,
  appendRepairRecord,
  repairBudgetAvailable,
  shouldAutoPromoteToActive,
  shouldDemoteAfterRepair,
  parseM7Header,
  serializeM7Header,
  REPAIR_BUDGET,
  HISTORY_LIMITS,
} from '../../dist/domain/reusable-action.js';

const FROZEN_DATE = '2026-04-30T15:00:00.000Z';
const fixedNow = () => new Date(FROZEN_DATE);

// ─────────────────────────────────────────────────────────────────────────────
// freshRuntimeState
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 freshRuntimeState: schema invariants', () => {
  const s = freshRuntimeState(fixedNow, 1234);
  assert.equal(s.schemaVersion, 1);
  assert.equal(s.revision, 1);
  assert.equal(s.updatedAt, FROZEN_DATE);
  assert.equal(s.lastSeenMtimeMs, 1234);
  assert.deepEqual(s.runHistory, []);
  assert.deepEqual(s.repairHistory, []);
  assert.equal(s.stats.totalRuns, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// appendRunRecord
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 appendRunRecord: pass updates stats correctly', () => {
  const s0 = freshRuntimeState(fixedNow, 0);
  const s1 = appendRunRecord(s0, {
    timestamp: FROZEN_DATE,
    durationMs: 4200,
    status: 'pass',
    trigger: 'agent',
  });
  assert.equal(s1.stats.totalRuns, 1);
  assert.equal(s1.stats.successCount, 1);
  assert.equal(s1.stats.failureCount, 0);
  assert.equal(s1.stats.avgDurationMs, 4200);
  assert.equal(s1.stats.lastSuccessAt, FROZEN_DATE);
  assert.equal(s1.runHistory.length, 1);
});

test('Phase127 appendRunRecord: avgDurationMs uses successful runs only', () => {
  let s = freshRuntimeState(fixedNow, 0);
  s = appendRunRecord(s, {
    timestamp: FROZEN_DATE,
    durationMs: 4000,
    status: 'pass',
    trigger: 'agent',
  });
  s = appendRunRecord(s, {
    timestamp: FROZEN_DATE,
    durationMs: 9999,
    status: 'fail',
    trigger: 'agent',
    failureCode: 'TIMEOUT',
  });
  s = appendRunRecord(s, {
    timestamp: FROZEN_DATE,
    durationMs: 6000,
    status: 'pass',
    trigger: 'agent',
  });
  assert.equal(s.stats.totalRuns, 3);
  assert.equal(s.stats.successCount, 2);
  assert.equal(s.stats.failureCount, 1);
  assert.equal(s.stats.avgDurationMs, 5000); // (4000 + 6000) / 2
});

test('Phase127 appendRunRecord: history bounded by RUN_HISTORY_MAX', () => {
  let s = freshRuntimeState(fixedNow, 0);
  for (let i = 0; i < HISTORY_LIMITS.RUN_HISTORY_MAX + 5; i++) {
    s = appendRunRecord(s, {
      timestamp: FROZEN_DATE,
      durationMs: 100,
      status: 'pass',
      trigger: 'agent',
    });
  }
  assert.equal(s.runHistory.length, HISTORY_LIMITS.RUN_HISTORY_MAX);
  assert.equal(s.stats.totalRuns, HISTORY_LIMITS.RUN_HISTORY_MAX + 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// appendRepairRecord
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 appendRepairRecord: bumps revision', () => {
  const s0 = freshRuntimeState(fixedNow, 0);
  const s1 = appendRepairRecord(s0, {
    timestamp: FROZEN_DATE,
    failureCode: 'SELECTOR_NOT_FOUND',
    diff: { selector: { from: 'old-id', to: 'new-id' } },
    durationMs: 1500,
  });
  assert.equal(s1.revision, 2);
  assert.equal(s1.repairHistory.length, 1);
});

test('Phase127 appendRepairRecord: history bounded by REPAIR_HISTORY_MAX', () => {
  let s = freshRuntimeState(fixedNow, 0);
  for (let i = 0; i < HISTORY_LIMITS.REPAIR_HISTORY_MAX + 5; i++) {
    s = appendRepairRecord(s, {
      timestamp: FROZEN_DATE,
      failureCode: 'SELECTOR_NOT_FOUND',
      diff: {},
      durationMs: 100,
    });
  }
  assert.equal(s.repairHistory.length, HISTORY_LIMITS.REPAIR_HISTORY_MAX);
  assert.equal(s.revision, 1 + HISTORY_LIMITS.REPAIR_HISTORY_MAX + 5);
});

// ─────────────────────────────────────────────────────────────────────────────
// repairBudgetAvailable
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 repairBudget: empty history → budget available', () => {
  assert.equal(repairBudgetAvailable(freshRuntimeState(fixedNow, 0), fixedNow), true);
});

test('Phase127 repairBudget: 3 repairs in last 24h → budget exhausted', () => {
  let s = freshRuntimeState(fixedNow, 0);
  // Three repairs all today — at the limit (budget < 3 means available)
  for (let i = 0; i < REPAIR_BUDGET.ATTEMPTS_PER_24H; i++) {
    s = appendRepairRecord(s, {
      timestamp: FROZEN_DATE,
      failureCode: 'SELECTOR_NOT_FOUND',
      diff: {},
      durationMs: 100,
    });
  }
  assert.equal(repairBudgetAvailable(s, fixedNow), false);
});

test("Phase127 repairBudget: old repairs (>24h) don't count against budget", () => {
  let s = freshRuntimeState(fixedNow, 0);
  // 5 repairs from a week ago → all stale
  const oldTs = '2026-04-23T15:00:00.000Z';
  for (let i = 0; i < 5; i++) {
    s = appendRepairRecord(s, {
      timestamp: oldTs,
      failureCode: 'SELECTOR_NOT_FOUND',
      diff: {},
      durationMs: 100,
    });
  }
  assert.equal(repairBudgetAvailable(s, fixedNow), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle transitions
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 shouldAutoPromoteToActive: experimental + pass → true', () => {
  const meta = { id: 'x', intent: 'y', status: 'experimental' };
  const lastRun = { timestamp: FROZEN_DATE, durationMs: 4000, status: 'pass', trigger: 'agent' };
  assert.equal(shouldAutoPromoteToActive(meta, lastRun), true);
});

test("Phase127 shouldAutoPromoteToActive: active flow doesn't re-promote", () => {
  const meta = { id: 'x', intent: 'y', status: 'active' };
  const lastRun = { timestamp: FROZEN_DATE, durationMs: 4000, status: 'pass', trigger: 'agent' };
  assert.equal(shouldAutoPromoteToActive(meta, lastRun), false);
});

test("Phase127 shouldAutoPromoteToActive: failed run doesn't promote", () => {
  const meta = { id: 'x', intent: 'y', status: 'experimental' };
  const lastRun = {
    timestamp: FROZEN_DATE,
    durationMs: 4000,
    status: 'fail',
    trigger: 'agent',
    failureCode: 'TIMEOUT',
  };
  assert.equal(shouldAutoPromoteToActive(meta, lastRun), false);
});

test('React-tree and partitioned passes never become Maestro certification', () => {
  const meta = { id: 'x', intent: 'y', status: 'experimental' };
  const base = { timestamp: FROZEN_DATE, durationMs: 4000, status: 'pass', trigger: 'agent' };
  assert.equal(shouldAutoPromoteToActive(meta, { ...base, proofDomain: 'react-tree' }), false);
  assert.equal(shouldAutoPromoteToActive(meta, { ...base, proofDomain: 'partitioned' }), false);
  assert.equal(shouldAutoPromoteToActive(meta, { ...base, proofDomain: 'xctest-native' }), true);
});

test('Phase127 shouldDemoteAfterRepair: active → experimental', () => {
  assert.equal(shouldDemoteAfterRepair({ id: 'x', intent: 'y', status: 'active' }), true);
  assert.equal(shouldDemoteAfterRepair({ id: 'x', intent: 'y', status: 'experimental' }), false);
  assert.equal(shouldDemoteAfterRepair({ id: 'x', intent: 'y', status: 'deprecated' }), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// parseM7Header
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_YAML = `appId: com.rndevagent.testapp
---
# id: wizard-create-task
# intent: Create a task end-to-end via the FAB
# tags: [tasks, wizard, create]
# mutates: true
# status: active
- launchApp
- tapOn:
    id: "fab-create-task"
`;

test('Phase127 parseM7Header: full header roundtrip', () => {
  const meta = parseM7Header(SAMPLE_YAML);
  assert.ok(meta);
  assert.equal(meta.id, 'wizard-create-task');
  assert.equal(meta.intent, 'Create a task end-to-end via the FAB');
  assert.deepEqual(meta.tags, ['tasks', 'wizard', 'create']);
  assert.equal(meta.mutates, true);
  assert.equal(meta.status, 'active');
});

test('Phase127 parseM7Header: missing required fields → null', () => {
  const noIntent = `# id: foo\n# status: active\n- launchApp`;
  assert.equal(parseM7Header(noIntent), null);
});

test('Phase127 parseM7Header: fallbackId used when id absent', () => {
  const noId = `# intent: do something\n# status: active\n- launchApp`;
  const meta = parseM7Header(noId, 'fallback-slug');
  assert.ok(meta);
  assert.equal(meta.id, 'fallback-slug');
});

test('Phase127 parseM7Header: defaults status to experimental when absent', () => {
  const noStatus = `# id: x\n# intent: y\n- launchApp`;
  const meta = parseM7Header(noStatus);
  assert.ok(meta);
  assert.equal(meta.status, 'experimental');
});

// ─────────────────────────────────────────────────────────────────────────────
// serializeM7Header
// ─────────────────────────────────────────────────────────────────────────────

test('Phase127 serializeM7Header: stable order, all fields', () => {
  const meta = {
    id: 'x',
    intent: 'do thing',
    tags: ['a', 'b'],
    mutates: true,
    status: 'active',
    params: ['TITLE', 'DESC'],
    appId: 'com.foo.app',
  };
  const out = serializeM7Header(meta);
  assert.match(out, /^# id: x/);
  assert.match(out, /# intent: do thing/);
  assert.match(out, /# tags: \[a, b\]/);
  assert.match(out, /# mutates: true/);
  assert.match(out, /# status: active/);
  assert.match(out, /# params: \[TITLE, DESC\]/);
  assert.match(out, /# appId: com\.foo\.app/);
});

test('serializeM7Header emits enginePin when present', () => {
  const out = serializeM7Header({
    id: 'x',
    intent: 'y',
    status: 'active',
    enginePin: 'maestro-runner@1.1.28',
  });
  assert.match(out, /# enginePin: maestro-runner@1\.1\.28/);
});

test('Phase127 serializeM7Header: omits absent optional fields', () => {
  const meta = { id: 'x', intent: 'y', status: 'experimental' };
  const out = serializeM7Header(meta);
  assert.doesNotMatch(out, /# tags:/);
  assert.doesNotMatch(out, /# mutates:/);
  assert.doesNotMatch(out, /# params:/);
  assert.doesNotMatch(out, /# appId:/);
});

test('Phase127 serializeM7Header: roundtrips through parseM7Header', () => {
  const meta = {
    id: 'wizard-create',
    intent: 'create a task',
    tags: ['tasks', 'create'],
    mutates: true,
    status: 'active',
    params: ['TITLE'],
  };
  const yaml = `appId: com.foo.app\n---\n${serializeM7Header(meta)}\n- launchApp`;
  const parsed = parseM7Header(yaml);
  assert.deepEqual(
    {
      id: parsed.id,
      intent: parsed.intent,
      tags: parsed.tags,
      mutates: parsed.mutates,
      status: parsed.status,
      params: parsed.params,
    },
    meta,
  );
});

test('Phase127 serializeM7Header: newlines stripped from VALUES (not between fields)', () => {
  const meta = { id: 'x\ninjected: y', intent: 'first\nrm -rf', status: 'active' };
  const out = serializeM7Header(meta);
  // Value-level newlines must be flattened so a malicious id/intent
  // cannot escape the YAML comment context and inject other directives.
  assert.match(out, /# id: x injected: y/);
  assert.match(out, /# intent: first rm -rf/);
  // Each field stays on its own line (newlines between fields are correct).
  // Verify count: 3 lines, exactly 2 newlines between them.
  assert.equal(out.split('\n').length, 3);
});

// D1209 produces field — hybrid composition state postconditions.
test('D1209 serializeM7Header: produces emits inline map with sorted keys', () => {
  const meta = {
    id: 'x',
    intent: 'y',
    status: 'active',
    produces: { route: 'home', authenticated: true, count: 3 },
  };
  const out = serializeM7Header(meta);
  // Sorted alphabetically: authenticated, count, route.
  assert.match(out, /# produces: \{ authenticated: true, count: 3, route: home \}/);
});

test('D1209 serializeM7Header: omits produces when undefined or empty', () => {
  const omitted = serializeM7Header({ id: 'x', intent: 'y', status: 'active' });
  assert.doesNotMatch(omitted, /# produces:/);
  const emptyMap = serializeM7Header({ id: 'x', intent: 'y', status: 'active', produces: {} });
  assert.doesNotMatch(emptyMap, /# produces:/);
});

test('D1209 parseM7Header: produces map roundtrips with mixed types', () => {
  const yaml =
    '# id: foo\n# intent: bar\n# status: active\n# produces: { authenticated: true, route: home, retries: 3 }\n';
  const meta = parseM7Header(yaml);
  assert.deepEqual(meta.produces, { authenticated: true, route: 'home', retries: 3 });
});

test('D1209 parseM7Header: produces handles boolean false + negative + decimal', () => {
  const yaml =
    '# id: foo\n# intent: bar\n# status: active\n# produces: { dirty: false, offset: -2, ratio: 0.75 }\n';
  const meta = parseM7Header(yaml);
  assert.deepEqual(meta.produces, { dirty: false, offset: -2, ratio: 0.75 });
});

test('D1209 parseM7Header: produces strips quotes around string values', () => {
  const yaml =
    '# id: foo\n# intent: bar\n# status: active\n# produces: { route: "Settings", lang: \'en-US\' }\n';
  const meta = parseM7Header(yaml);
  assert.deepEqual(meta.produces, { route: 'Settings', lang: 'en-US' });
});

test('D1209 parseM7Header: produces empty braces yields undefined', () => {
  const yaml = '# id: foo\n# intent: bar\n# status: active\n# produces: { }\n';
  const meta = parseM7Header(yaml);
  assert.equal(meta.produces, undefined);
});

test('D1209 parseM7Header: produces missing field stays undefined', () => {
  const yaml = '# id: foo\n# intent: bar\n# status: active\n';
  const meta = parseM7Header(yaml);
  assert.equal(meta.produces, undefined);
});

test('D1209 serializeM7Header → parseM7Header: full produces roundtrip', () => {
  const original = {
    id: 'user-login',
    intent: 'Log in via email + password',
    status: 'active',
    produces: { authenticated: true, route: 'home', userTier: 'premium' },
  };
  const out = serializeM7Header(original);
  const parsed = parseM7Header(out);
  assert.deepEqual(parsed.produces, original.produces);
});
