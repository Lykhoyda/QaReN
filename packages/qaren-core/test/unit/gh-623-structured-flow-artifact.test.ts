// GH #623 — producer artifact reader: report.json + flows/flow-000.json →
// StructuredFlowArtifact. Finalization is evidence, not a favor: any missing,
// inconsistent, or non-terminal shape reads as unfinalized.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readStructuredFlowArtifact } from '../../dist/domain/maestro-runner-report.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gh623-artifact-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeReport(report: unknown, flowData?: unknown, dataFile = 'flows/flow-000.json'): void {
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report), 'utf8');
  if (flowData !== undefined) {
    mkdirSync(join(dir, 'flows'), { recursive: true });
    writeFileSync(join(dir, dataFile), JSON.stringify(flowData), 'utf8');
  }
}

const FLOW_ENTRY = {
  status: 'failed',
  dataFile: 'flows/flow-000.json',
  commands: { total: 3, passed: 2, failed: 1, skipped: 0, running: 0, pending: 0 },
};

const FLOW_DATA = {
  commands: [
    { id: 'cmd-000', index: 0, type: 'tapOn', status: 'passed' },
    { id: 'cmd-001', index: 1, type: 'inputText', status: 'passed' },
    {
      id: 'cmd-002',
      index: 2,
      type: 'extendedWaitUntil',
      status: 'failed',
      error: { type: 'unknown', message: 'Wait condition not met within 30s' },
    },
  ],
};

test('gh-623: a terminal report with a consistent data file reads finalized', () => {
  writeReport({ status: 'failed', flows: [FLOW_ENTRY] }, FLOW_DATA);
  const artifact = readStructuredFlowArtifact(dir);
  assert.ok(artifact);
  assert.equal(artifact.finalized, true);
  assert.equal(artifact.flowStatus, 'failed');
  assert.equal(artifact.commands.length, 3);
  assert.deepEqual(artifact.commands[2], {
    index: 2,
    type: 'extendedWaitUntil',
    status: 'failed',
    error: 'Wait condition not met within 30s',
  });
});

test('gh-623: no report dir or report file reads null', () => {
  assert.equal(readStructuredFlowArtifact(null), null);
  assert.equal(readStructuredFlowArtifact(dir), null);
});

test('gh-623: non-terminal, inconsistent, or malformed shapes read unfinalized', () => {
  const unfinalized = [
    // report still running
    [{ status: 'running', flows: [FLOW_ENTRY] }, FLOW_DATA],
    // flow count mismatch vs data file — ONLY total differs, all else valid
    [
      {
        status: 'failed',
        flows: [{ ...FLOW_ENTRY, commands: { ...FLOW_ENTRY.commands, total: 5 } }],
      },
      FLOW_DATA,
    ],
    // command still running — aggregate counts internally consistent
    [
      {
        status: 'failed',
        flows: [
          {
            ...FLOW_ENTRY,
            commands: { total: 1, passed: 0, failed: 0, skipped: 0, running: 1, pending: 0 },
          },
        ],
      },
      { commands: [{ index: 0, type: 'tapOn', status: 'running' }] },
    ],
    // zero flows / two flows
    [{ status: 'failed', flows: [] }, FLOW_DATA],
    [{ status: 'failed', flows: [FLOW_ENTRY, FLOW_ENTRY] }, FLOW_DATA],
    // missing data file
    [{ status: 'failed', flows: [FLOW_ENTRY] }, undefined],
    // report/flow status disagreement — each terminal on its own
    [{ status: 'passed', flows: [FLOW_ENTRY] }, FLOW_DATA],
    // aggregate count contradiction: passed says 1, rows say 2
    [
      {
        status: 'failed',
        flows: [{ ...FLOW_ENTRY, commands: { ...FLOW_ENTRY.commands, passed: 1 } }],
      },
      FLOW_DATA,
    ],
    // malformed row: a command without a type
    [
      { status: 'failed', flows: [FLOW_ENTRY] },
      {
        commands: [
          { index: 0, status: 'passed' },
          { index: 1, type: 'inputText', status: 'passed' },
          { index: 2, type: 'extendedWaitUntil', status: 'failed' },
        ],
      },
    ],
    // malformed row: an unrecognized status string
    [
      { status: 'failed', flows: [FLOW_ENTRY] },
      {
        commands: [
          { index: 0, type: 'tapOn', status: 'exploded' },
          { index: 1, type: 'inputText', status: 'passed' },
          { index: 2, type: 'extendedWaitUntil', status: 'failed' },
        ],
      },
    ],
  ] as const;
  for (const [report, flowData] of unfinalized) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeReport(report, flowData);
    const artifact = readStructuredFlowArtifact(dir);
    assert.ok(artifact, JSON.stringify(report));
    assert.equal(artifact.finalized, false, JSON.stringify(report));
  }
});

test('gh-623: an absolute or parent-escaping dataFile path is refused even when it exists', () => {
  // A perfectly valid, finalized-looking data file OUTSIDE the report tree:
  // containment, not existence, must be what refuses it.
  const outside = mkdtempSync(join(tmpdir(), 'gh623-outside-'));
  try {
    writeFileSync(join(outside, 'outside.json'), JSON.stringify(FLOW_DATA), 'utf8');
    const reportName = dir.split('/').at(-1)!;
    for (const dataFile of [
      join(outside, 'outside.json'),
      `../${outside.split('/').at(-1)!}/outside.json`,
      `flows/../../${reportName}/../${outside.split('/').at(-1)!}/outside.json`,
    ]) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeReport({ status: 'failed', flows: [{ ...FLOW_ENTRY, dataFile }] });
      const artifact = readStructuredFlowArtifact(dir);
      assert.ok(artifact);
      assert.equal(artifact.finalized, false, dataFile);
      assert.equal(artifact.commands.length, 0, dataFile);
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('gh-623: a backslash dataFile path is refused on POSIX', () => {
  const dataFile = 'flows\\flow-000.json';
  writeReport({ status: 'failed', flows: [{ ...FLOW_ENTRY, dataFile }] });
  writeFileSync(join(dir, dataFile), JSON.stringify(FLOW_DATA), 'utf8');

  const artifact = readStructuredFlowArtifact(dir);
  assert.ok(artifact);
  assert.equal(artifact.finalized, false);
  assert.equal(artifact.commands.length, 0);
});
