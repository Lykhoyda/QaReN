// GH #623 — canonical ledger + the one trailing-verification classifier.
// Ledger evidence only: no test here proves anything from renderer text, step
// counts, ordering, screenshots, route, or timing (ledger amendment §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMaestroRunLedger,
  classifyTrailingVerification,
  commandEffect,
  type BuildLedgerInput,
  type StructuredFlowArtifact,
} from '../../dist/domain/maestro-run-ledger.js';

const ATTEMPT = { attemptId: 'att-1', ordinal: 1, maxAttempts: 1, kind: 'initial' as const };

function cleanTermination(exitCode: number) {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    outputTruncated: false,
    bootstrapFailure: false,
    transportFailure: false,
  };
}

function artifact(
  commands: Array<[string, 'passed' | 'failed' | 'skipped']>,
  finalized = true,
): StructuredFlowArtifact {
  return {
    finalized,
    flowStatus: commands.some(([, status]) => status === 'failed') ? 'failed' : 'passed',
    commands: commands.map(([type, status], index) => ({ index, type, status })),
  };
}

// Registration-style flow: launchApp stage, then mutations + trailing waits.
const REGISTRATION_COMMANDS: unknown[] = [
  { launchApp: { appId: 'com.demo' } },
  { tapOn: { id: 'email' } },
  { inputText: 'user@example.com' },
  { tapOn: { id: 'password' } },
  { inputText: 'hunter2' },
  { tapOn: { id: 'register_submit' } },
  { extendedWaitUntil: { visible: { id: 'home_screen' }, timeout: 30000 } },
];

function registrationInput(
  stage1: Array<[string, 'passed' | 'failed' | 'skipped']>,
  overrides: Partial<BuildLedgerInput> = {},
): BuildLedgerInput {
  return {
    attempt: ATTEMPT,
    sourceText: 'appId: com.demo\n---\n…',
    commands: REGISTRATION_COMMANDS,
    stages: [
      {
        sourceIndices: [0],
        requiresOrigin: false,
        invocation: {
          termination: cleanTermination(0),
          artifact: artifact([['launchApp', 'passed']]),
        },
      },
      {
        sourceIndices: [1, 2, 3, 4, 5, 6],
        requiresOrigin: true,
        invocation: { termination: cleanTermination(1), artifact: artifact(stage1) },
      },
    ],
    ...overrides,
  };
}

const TRAILING_WAIT_STAGE: Array<[string, 'passed' | 'failed' | 'skipped']> = [
  ['tapOn', 'passed'],
  ['inputText', 'passed'],
  ['tapOn', 'passed'],
  ['inputText', 'passed'],
  ['tapOn', 'passed'],
  ['extendedWaitUntil', 'failed'],
];

test('gh-623 case 1: trailing wait timeout with every mutation proven grants the qualifier', () => {
  const ledger = buildMaestroRunLedger(registrationInput(TRAILING_WAIT_STAGE));
  assert.equal(ledger.attempt.complete, true);
  const mutationRows = ledger.operations.filter((operation) => operation.effect === 'mutation');
  assert.equal(mutationRows.length, 6);
  assert.ok(
    mutationRows.every(
      (operation) => operation.outcome.state === 'proven' && operation.outcome.status === 'passed',
    ),
  );
  const qualifier = classifyTrailingVerification(ledger);
  assert.ok(qualifier, 'qualifier must be granted');
  assert.equal(qualifier.trailingVerificationOnly, true);
  assert.equal(qualifier.mutationEvidence, 'proven');
  assert.equal(qualifier.provenMutations, 6);
  assert.equal(qualifier.failedVerifications, 1);
  assert.deepEqual(qualifier.attempt, { attemptId: 'att-1', ordinal: 1, kind: 'initial' });
});

test('gh-623 case 2: one mutation row unknown withholds the qualifier — unknown stays unknown', () => {
  // Artifact carries one MORE tapOn than authored: the class count mismatches,
  // so every tapOn row stays unknown and the stage is marked deviated.
  const ledger = buildMaestroRunLedger(
    registrationInput([...TRAILING_WAIT_STAGE, ['tapOn', 'passed']]),
  );
  const tapRows = ledger.operations.filter((operation) => operation.verb === 'tapOn');
  assert.ok(tapRows.every((operation) => operation.outcome.state === 'unknown'));
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 3: duplicated launchApp rendering never borrows a favorable mapping', () => {
  // The staged-runner shape from review finding 6: the lifecycle stage's
  // artifact reports TWO launchApp executions for ONE authored command.
  const input = registrationInput(TRAILING_WAIT_STAGE);
  input.stages[0].invocation!.artifact = artifact([
    ['launchApp', 'passed'],
    ['launchApp', 'passed'],
  ]);
  const ledger = buildMaestroRunLedger(input);
  const launchRow = ledger.operations.find((operation) => operation.verb === 'launchApp')!;
  assert.equal(launchRow.outcome.state, 'unknown');
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 4: an early mutating-step failure keeps the qualifier withheld', () => {
  const ledger = buildMaestroRunLedger(
    registrationInput([
      ['tapOn', 'passed'],
      ['inputText', 'passed'],
      ['tapOn', 'passed'],
      ['inputText', 'passed'],
      ['tapOn', 'failed'],
      ['extendedWaitUntil', 'skipped'],
    ]),
  );
  // Mixed statuses inside the tapOn class: individual attribution unprovable.
  const tapRows = ledger.operations.filter((operation) => operation.verb === 'tapOn');
  assert.ok(tapRows.every((operation) => operation.outcome.state === 'unknown'));
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 4b: a sole failed mutation is proven-failed and refused', () => {
  const commands: unknown[] = [
    { tapOn: { id: 'submit' } },
    { extendedWaitUntil: { visible: { id: 'done' } } },
  ];
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0, 1],
        requiresOrigin: true,
        invocation: {
          termination: cleanTermination(1),
          artifact: artifact([
            ['tapOn', 'failed'],
            ['extendedWaitUntil', 'skipped'],
          ]),
        },
      },
    ],
  });
  const tapRow = ledger.operations.find((operation) => operation.verb === 'tapOn')!;
  assert.deepEqual(tapRow.outcome, { state: 'proven', status: 'failed' });
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 5: termination provenance gates the qualifier regardless of row states', () => {
  for (const bad of [
    { timedOut: true },
    { signal: 'SIGTERM' },
    { exitCode: null },
    { exitCode: Number.NaN },
    { outputTruncated: true },
    { bootstrapFailure: true },
    { transportFailure: true },
  ] as const) {
    const input = registrationInput(TRAILING_WAIT_STAGE);
    input.stages[1].invocation!.termination = { ...cleanTermination(1), ...bad };
    const ledger = buildMaestroRunLedger(input);
    assert.equal(ledger.attempt.complete, false, JSON.stringify(bad));
    assert.equal(classifyTrailingVerification(ledger), null, JSON.stringify(bad));
  }
  const unfinalized = registrationInput(TRAILING_WAIT_STAGE);
  unfinalized.stages[1].invocation!.artifact = artifact(TRAILING_WAIT_STAGE, false);
  const ledger = buildMaestroRunLedger(unfinalized);
  assert.equal(ledger.attempt.complete, false);
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 5b: a stage never invoked leaves its mutations notRun and refuses', () => {
  const commands: unknown[] = [{ tapOn: { id: 'a' } }, { killApp: 'com.demo' }];
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0],
        requiresOrigin: true,
        invocation: { termination: cleanTermination(1), artifact: artifact([['tapOn', 'failed']]) },
      },
      { sourceIndices: [1], requiresOrigin: false, invocation: null },
    ],
  });
  assert.equal(ledger.attempt.complete, false);
  assert.deepEqual(ledger.operations[1].outcome, { state: 'notRun' });
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 6: a repaired attempt classifies identically and carries lineage', () => {
  const ledger = buildMaestroRunLedger(
    registrationInput(TRAILING_WAIT_STAGE, {
      attempt: {
        attemptId: 'att-2',
        ordinal: 2,
        maxAttempts: 2,
        kind: 'repaired',
        parentAttemptId: 'att-1',
      },
    }),
  );
  const qualifier = classifyTrailingVerification(ledger);
  assert.ok(qualifier);
  assert.deepEqual(qualifier.attempt, {
    attemptId: 'att-2',
    ordinal: 2,
    kind: 'repaired',
    parentAttemptId: 'att-1',
  });
});

test('gh-623 case 7: a fully passing attempt yields no qualifier at all', () => {
  const ledger = buildMaestroRunLedger(
    registrationInput([
      ['tapOn', 'passed'],
      ['inputText', 'passed'],
      ['tapOn', 'passed'],
      ['inputText', 'passed'],
      ['tapOn', 'passed'],
      ['extendedWaitUntil', 'passed'],
    ]),
  );
  assert.equal(ledger.attempt.complete, true);
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 9: the qualifier applies by row effect, independent of selector grammar', () => {
  // Selector-less/text/regex waits and asserts: the classifier keys on the
  // authored verb's effect, never on any selector-parser kind.
  const commands: unknown[] = [
    { tapOn: { id: 'go' } },
    { assertVisible: { text: 'Welcome.*' } },
    'waitForAnimationToEnd',
  ];
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0, 1, 2],
        requiresOrigin: true,
        invocation: {
          termination: cleanTermination(1),
          artifact: artifact([
            ['tapOn', 'passed'],
            ['assertVisible', 'failed'],
            ['waitForAnimationToEnd', 'skipped'],
          ]),
        },
      },
    ],
  });
  const qualifier = classifyTrailingVerification(ledger);
  assert.ok(qualifier);
  assert.equal(qualifier.provenMutations, 1);
  assert.equal(qualifier.notRunOperations, 1);
});

test('gh-623: unknown-effect verbs (scripts, containers) always withhold the qualifier', () => {
  const commands: unknown[] = [
    { tapOn: { id: 'go' } },
    { evalScript: '${output.x = 1}' },
    { extendedWaitUntil: { visible: { id: 'done' } } },
  ];
  assert.equal(commandEffect('evalScript'), 'unknown');
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0, 1, 2],
        requiresOrigin: true,
        invocation: {
          termination: cleanTermination(1),
          artifact: artifact([
            ['tapOn', 'passed'],
            ['evalScript', 'passed'],
            ['extendedWaitUntil', 'failed'],
          ]),
        },
      },
    ],
  });
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623: a failed control command is never reported as trailing verification', () => {
  const commands: unknown[] = [
    { tapOn: { id: 'go' } },
    { takeScreenshot: 'shot' },
    { extendedWaitUntil: { visible: { id: 'done' } } },
  ];
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0, 1, 2],
        requiresOrigin: true,
        invocation: {
          termination: cleanTermination(1),
          artifact: artifact([
            ['tapOn', 'passed'],
            ['takeScreenshot', 'failed'],
            ['extendedWaitUntil', 'skipped'],
          ]),
        },
      },
    ],
  });
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623: stage captures that do not cover every authored command refuse completeness', () => {
  // Keep the stage internally consistent (5 authored rows, 5 matching artifact
  // entries, all statuses attributable) so ONLY the uncovered authored command
  // — the trailing wait at source index 6 — can make the attempt incomplete.
  const input = registrationInput(TRAILING_WAIT_STAGE.slice(0, 5));
  input.stages[1].sourceIndices = [1, 2, 3, 4, 5];
  const ledger = buildMaestroRunLedger(input);
  assert.ok(
    ledger.operations
      .filter((operation) => operation.stageId !== 'unassigned')
      .every(
        (operation) =>
          operation.outcome.state === 'proven' && operation.outcome.status === 'passed',
      ),
    'every captured row must be individually proven so coverage is the only gap',
  );
  // One preallocated row per authored command: the uncovered trailing wait
  // still appears, unassigned and unknown — never silently absent.
  const uncovered = ledger.operations.find((operation) => operation.sourceIndex === 6);
  assert.ok(uncovered);
  assert.equal(uncovered.stageId, 'unassigned');
  assert.deepEqual(uncovered.outcome, { state: 'unknown' });
  assert.equal(ledger.operations.length, REGISTRATION_COMMANDS.length);
  assert.equal(ledger.attempt.complete, false);
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623: an ambiguously mapped trailing verification never qualifies, even with proven mutations', () => {
  // Two authored waits, artifact carries two entries with MIXED statuses: the
  // failed one cannot be attributed to a specific authored row, so both stay
  // unknown and the qualifier is withheld despite every mutation being proven.
  const commands: unknown[] = [
    { tapOn: { id: 'go' } },
    { extendedWaitUntil: { visible: { id: 'spinner' } } },
    { extendedWaitUntil: { visible: { id: 'home' } } },
  ];
  const ledger = buildMaestroRunLedger({
    attempt: ATTEMPT,
    sourceText: 's',
    commands,
    stages: [
      {
        sourceIndices: [0, 1, 2],
        requiresOrigin: true,
        invocation: {
          termination: cleanTermination(1),
          artifact: artifact([
            ['tapOn', 'passed'],
            ['extendedWaitUntil', 'passed'],
            ['extendedWaitUntil', 'failed'],
          ]),
        },
      },
    ],
  });
  const tapRow = ledger.operations.find((operation) => operation.verb === 'tapOn')!;
  assert.deepEqual(tapRow.outcome, { state: 'proven', status: 'passed' });
  const waitRows = ledger.operations.filter((operation) => operation.verb === 'extendedWaitUntil');
  assert.ok(waitRows.every((operation) => operation.outcome.state === 'unknown'));
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 case 5c: corrupt termination on an EARLIER stage gates even a clean final stage', () => {
  for (const bad of [
    { timedOut: true },
    { signal: 'SIGKILL' },
    { outputTruncated: true },
    { transportFailure: true },
  ] as const) {
    const input = registrationInput(TRAILING_WAIT_STAGE);
    input.stages[0].invocation!.termination = { ...cleanTermination(0), ...bad };
    const ledger = buildMaestroRunLedger(input);
    assert.equal(ledger.attempt.complete, false, JSON.stringify(bad));
    assert.equal(classifyTrailingVerification(ledger), null, JSON.stringify(bad));
  }
});

test('gh-623 case 5d: a spawn-error stage (no artifact, transport failure) refuses', () => {
  const input = registrationInput(TRAILING_WAIT_STAGE);
  input.stages[0].invocation = {
    termination: { ...cleanTermination(0), exitCode: null, transportFailure: true },
    artifact: null,
  };
  const ledger = buildMaestroRunLedger(input);
  assert.equal(ledger.attempt.complete, false);
  assert.ok(
    ledger.operations
      .filter((operation) => operation.stageId === 'stage-0')
      .every((operation) => operation.outcome.state === 'unknown'),
  );
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623: the qualifier block carries full per-stage termination provenance', () => {
  const qualifier = classifyTrailingVerification(
    buildMaestroRunLedger(registrationInput(TRAILING_WAIT_STAGE)),
  )!;
  assert.deepEqual(qualifier.stageTerminations, [
    {
      exitCode: 0,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      bootstrapFailure: false,
      transportFailure: false,
      artifactFinalized: true,
    },
    {
      exitCode: 1,
      signal: null,
      timedOut: false,
      outputTruncated: false,
      bootstrapFailure: false,
      transportFailure: false,
      artifactFinalized: true,
    },
  ]);
});

// Classifier defense-in-depth: the builder cannot produce these states, so
// each gate is isolated by hand-mutating an otherwise qualifying ledger.
function qualifyingLedger() {
  const ledger = buildMaestroRunLedger(registrationInput(TRAILING_WAIT_STAGE));
  assert.ok(classifyTrailingVerification(ledger), 'precondition: ledger must qualify');
  return ledger;
}

test('gh-623 defense: exactly one unknown mutation row alone withholds the qualifier', () => {
  const ledger = qualifyingLedger();
  const mutation = ledger.operations.find(
    (operation) =>
      operation.effect === 'mutation' &&
      operation.outcome.state === 'proven' &&
      operation.outcome.status === 'passed',
  )!;
  mutation.outcome = { state: 'unknown' };
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 defense: exactly one notRun mutation row alone withholds the qualifier', () => {
  const ledger = qualifyingLedger();
  const mutation = ledger.operations.find((operation) => operation.effect === 'mutation')!;
  mutation.outcome = { state: 'notRun' };
  assert.equal(classifyTrailingVerification(ledger), null);
});

test('gh-623 defense: corrupt termination provenance refuses even with complete:true and proven rows', () => {
  for (const bad of [
    { timedOut: true },
    { signal: 'SIGTERM' },
    { exitCode: null },
    { exitCode: Number.NaN },
    { outputTruncated: true },
    { bootstrapFailure: true },
    { transportFailure: true },
    { artifactFinalized: false },
  ] as const) {
    const ledger = qualifyingLedger();
    ledger.stages[1].invocationTermination = {
      ...ledger.stages[1].invocationTermination!,
      ...bad,
    };
    assert.equal(classifyTrailingVerification(ledger), null, JSON.stringify(bad));
  }
  const missing = qualifyingLedger();
  missing.stages[0].invocationTermination = null;
  assert.equal(classifyTrailingVerification(missing), null);
});

test('gh-623 defense: malformed attempt lineage refuses the qualifier', () => {
  const repairedWithoutParent = qualifyingLedger();
  repairedWithoutParent.attempt.kind = 'repaired';
  delete repairedWithoutParent.attempt.parentAttemptId;
  assert.equal(classifyTrailingVerification(repairedWithoutParent), null);

  const initialWithParent = qualifyingLedger();
  initialWithParent.attempt.parentAttemptId = 'att-0';
  assert.equal(classifyTrailingVerification(initialWithParent), null);
});

test('gh-623: source digest and observation producer attribution are recorded', () => {
  const ledger = buildMaestroRunLedger(registrationInput(TRAILING_WAIT_STAGE));
  assert.match(ledger.attempt.sourceDigest, /^[0-9a-f]{64}$/);
  assert.ok(ledger.observations.length >= 7);
  assert.ok(
    ledger.observations.every((observation) => observation.producer === 'maestro-commands-json'),
  );
  const failedObservation = ledger.observations.find(
    (observation) => observation.status === 'failed',
  )!;
  assert.equal(failedObservation.mapping.kind, 'exact');
});
