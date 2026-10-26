// GH #623 — canonical per-attempt, per-source-operation ledger (captain-approved
// architecture, data/issue-623-trailing-wait-e0b5b13f + Aug-29 ledger amendment).
// Pure, no I/O. Emitted inside maestro_run BEFORE stage outputs are flattened;
// the ONE classifier below is the only source of the trailing-verification
// qualifier for initial and repaired attempts alike. Never classifies from
// renderer text, ordering, rendered-line counts, or step counts: the only
// command-outcome evidence is the producer's structured per-command artifact,
// joined to authored commands by per-stage verb-class counting. Unknown stays
// unknown — a row is never promoted by position or favorable fallback.

import { createHash } from 'node:crypto';

export const MAESTRO_RUN_LEDGER_SCHEMA_VERSION = 1;
export const MAESTRO_RUNNER_FLOW_JSON_ADAPTER = 'maestro-runner/flow-json@1';

export type LedgerAttemptKind = 'initial' | 'repaired';

/** Lineage is discriminated: a repaired attempt MUST name its parent, an initial one cannot. */
export type LedgerAttemptInput = {
  attemptId: string;
  ordinal: number;
  maxAttempts: number;
} & ({ kind: 'initial'; parentAttemptId?: never } | { kind: 'repaired'; parentAttemptId: string });

export type LedgerAttempt = LedgerAttemptInput & {
  sourceDigest: string;
  complete: boolean;
};

export interface LedgerInvocationTermination {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputTruncated: boolean;
  bootstrapFailure: boolean;
  transportFailure: boolean;
  artifactFinalized: boolean;
}

export interface LedgerStage {
  stageId: string;
  authorityKind: 'origin' | 'lifecycle';
  sourceOperationIds: string[];
  invoked: boolean;
  invocationTermination: LedgerInvocationTermination | null;
}

export type LedgerObservationStatus =
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'running'
  | 'pending'
  | 'unknown';

export type LedgerMapping =
  | { kind: 'exact'; operationId: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

export interface LedgerObservation {
  producer: 'maestro-commands-json' | 'renderer' | 'parent-process';
  producerSequence?: number;
  stageId: string;
  command: string;
  status: LedgerObservationStatus;
  error?: string;
  mapping: LedgerMapping;
}

export type LedgerOperationEffect = 'mutation' | 'verification' | 'control' | 'unknown';

export type LedgerOperationOutcome =
  | { state: 'proven'; status: 'passed' | 'failed' }
  | { state: 'notRun' }
  | { state: 'unknown' };

export interface LedgerOperation {
  operationId: string;
  sourceIndex: number;
  sourceRange: [number, number];
  sourceDigest: string;
  verb: string;
  effect: LedgerOperationEffect;
  stageId: string;
  outcome: LedgerOperationOutcome;
}

export interface MaestroRunLedger {
  schemaVersion: typeof MAESTRO_RUN_LEDGER_SCHEMA_VERSION;
  producerAdapterVersion: string;
  attempt: LedgerAttempt;
  stages: LedgerStage[];
  observations: LedgerObservation[];
  operations: LedgerOperation[];
}

/** Structured per-command evidence parsed from the producer's flow JSON artifact. */
export interface StructuredFlowArtifact {
  finalized: boolean;
  flowStatus: 'passed' | 'failed' | 'unknown';
  commands: Array<{
    index: number;
    type: string;
    status: LedgerObservationStatus;
    error?: string;
  }>;
}

export interface LedgerStageCaptureInput {
  sourceIndices: number[];
  requiresOrigin: boolean;
  /** null when the stage was planned but never invoked (an earlier stage failed). */
  invocation: {
    termination: Omit<LedgerInvocationTermination, 'artifactFinalized'>;
    artifact: StructuredFlowArtifact | null;
  } | null;
}

export interface BuildLedgerInput {
  attempt: LedgerAttemptInput;
  /** Exact validated flow source (the YAML text handed to the producer). */
  sourceText: string;
  /** Authored commands in source order (maestro-validator output). */
  commands: readonly unknown[];
  stages: LedgerStageCaptureInput[];
}

// Aligned to maestro-validator's ALLOWED_COMMANDS — every command the
// validator can emit has a defined effect; anything else (runFlow containers
// included) stays 'unknown' and withholds the qualifier.
const MUTATION_VERBS = new Set([
  'launchApp',
  'stopApp',
  'killApp',
  'clearState',
  'tap',
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'back',
  'inputText',
  'eraseText',
  'pasteText',
  'hideKeyboard',
  'pressKey',
  'scroll',
  'scrollUntilVisible',
  'swipe',
  'swipeUp',
  'swipeDown',
  'swipeLeft',
  'swipeRight',
  'openLink',
  'setLocation',
  'addMedia',
  'setAirplaneMode',
  'travel',
]);

const VERIFICATION_VERBS = new Set([
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'waitForAnimationToEnd',
]);

const CONTROL_VERBS = new Set(['takeScreenshot', 'copyTextFrom']);

export function commandEffect(verb: string): LedgerOperationEffect {
  if (MUTATION_VERBS.has(verb)) return 'mutation';
  if (VERIFICATION_VERBS.has(verb)) return 'verification';
  if (CONTROL_VERBS.has(verb)) return 'control';
  return 'unknown';
}

function authoredVerb(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const keys = Object.keys(command as Record<string, unknown>);
  return keys.length === 1 ? keys[0]! : null;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function digestCommand(command: unknown): string {
  try {
    return sha256(JSON.stringify(command) ?? String(command));
  } catch {
    return sha256(String(command));
  }
}

interface VerbClassEvidence {
  operationIds: string[];
  statuses: LedgerObservationStatus[];
}

function terminationClean(t: LedgerInvocationTermination): boolean {
  return (
    Number.isFinite(t.exitCode) &&
    !t.timedOut &&
    t.signal === null &&
    !t.outputTruncated &&
    !t.bootstrapFailure &&
    !t.transportFailure &&
    t.artifactFinalized
  );
}

/**
 * Build the canonical ledger for ONE producer attempt. Stage captures arrive in
 * plan order; a stage never invoked (an earlier stage aborted the plan) carries
 * `invocation: null` and its operations are `notRun` on parent-process evidence.
 */
export function buildMaestroRunLedger(input: BuildLedgerInput): MaestroRunLedger {
  const stages: LedgerStage[] = [];
  const observations: LedgerObservation[] = [];

  // Exactly ONE preallocated row per authored command, before any stage is
  // reconciled onto them. Rows no stage claims stay unassigned and unknown.
  const operations: LedgerOperation[] = input.commands.map((command, index) => {
    const verb = authoredVerb(command);
    return {
      operationId: `op-${index}`,
      sourceIndex: index,
      sourceRange: [index, index],
      sourceDigest: digestCommand(command),
      verb: verb ?? `unknown-${index}`,
      effect: verb === null ? 'unknown' : commandEffect(verb),
      stageId: 'unassigned',
      outcome: { state: 'unknown' },
    };
  });
  const claimedIndices = new Set<number>();
  let claimConflict = false;

  input.stages.forEach((capture, stageIndex) => {
    const stageId = `stage-${stageIndex}`;
    const artifact = capture.invocation?.artifact ?? null;
    const artifactFinalized = artifact?.finalized === true;
    const termination: LedgerInvocationTermination | null = capture.invocation
      ? { ...capture.invocation.termination, artifactFinalized }
      : null;

    // Claim preallocated rows: only indices that exist and were not already
    // claimed by an earlier stage bind to this stage; a duplicate or
    // out-of-range claim is a conflict and leaves rows unknown/unassigned.
    const stageOperations: LedgerOperation[] = [];
    for (const sourceIndex of capture.sourceIndices) {
      const row = operations[sourceIndex];
      if (!row || claimedIndices.has(sourceIndex)) {
        claimConflict = true;
        continue;
      }
      claimedIndices.add(sourceIndex);
      row.stageId = stageId;
      stageOperations.push(row);
    }

    if (!capture.invocation) {
      for (const operation of stageOperations) operation.outcome = { state: 'notRun' };
    } else if (
      artifact &&
      artifactFinalized &&
      artifactSelfConsistent(artifact) &&
      terminationClean(termination!)
    ) {
      assignOutcomesFromArtifact(stageOperations, artifact, stageId, observations);
    } else if (artifact) {
      // Artifact present but the invocation is not clean evidence — record the
      // producer observations without promoting any row beyond unknown.
      recordObservations(stageOperations, artifact, stageId, observations);
    }

    stages.push({
      stageId,
      authorityKind: capture.requiresOrigin ? 'origin' : 'lifecycle',
      sourceOperationIds: stageOperations.map((operation) => operation.operationId),
      invoked: capture.invocation !== null,
      invocationTermination: termination,
    });
  });

  // Coverage guard: the stage captures must partition the authored commands
  // exactly (each source index claimed once, none left over). A gap, duplicate
  // or out-of-range claim means the ledger does not represent the attempt and
  // can never be classified favorably.
  const coversAllCommands = !claimConflict && claimedIndices.size === input.commands.length;

  const complete =
    coversAllCommands &&
    input.stages.length > 0 &&
    input.stages.every(
      (capture) =>
        capture.invocation !== null &&
        capture.invocation.artifact?.finalized === true &&
        capture.invocation.artifact.flowStatus !== 'unknown',
    ) &&
    stages.every(
      (stage) =>
        stage.invocationTermination !== null && terminationClean(stage.invocationTermination),
    );

  return {
    schemaVersion: MAESTRO_RUN_LEDGER_SCHEMA_VERSION,
    producerAdapterVersion: MAESTRO_RUNNER_FLOW_JSON_ADAPTER,
    attempt: {
      ...input.attempt,
      sourceDigest: sha256(input.sourceText),
      complete,
    },
    stages,
    observations,
    operations,
  };
}

function recordObservations(
  stageOperations: LedgerOperation[],
  artifact: StructuredFlowArtifact,
  stageId: string,
  observations: LedgerObservation[],
): void {
  const byVerb = new Map<string, string[]>();
  for (const operation of stageOperations) {
    const ids = byVerb.get(operation.verb) ?? [];
    ids.push(operation.operationId);
    byVerb.set(operation.verb, ids);
  }
  const observedCounts = new Map<string, number>();
  for (const command of artifact.commands) {
    observedCounts.set(command.type, (observedCounts.get(command.type) ?? 0) + 1);
  }
  for (const command of artifact.commands) {
    const candidates = byVerb.get(command.type) ?? [];
    // 'exact' only for a genuine one-to-one verb class: one authored row AND
    // one producer entry. A single candidate shared by several entries is
    // still ambiguous — the ledger never advertises a join it cannot prove.
    const oneToOne = candidates.length === 1 && observedCounts.get(command.type) === 1;
    observations.push({
      producer: 'maestro-commands-json',
      producerSequence: command.index,
      stageId,
      command: command.type,
      status: command.status,
      ...(command.error ? { error: command.error.slice(0, 500) } : {}),
      mapping: oneToOne
        ? { kind: 'exact', operationId: candidates[0] }
        : candidates.length >= 1
          ? { kind: 'ambiguous', candidates: [...candidates] }
          : { kind: 'none' },
    });
  }
}

// A finalized artifact must agree with itself: a 'passed' flow with a failed
// row (or a 'failed' flow with none) is contradictory producer evidence and
// proves nothing.
function artifactSelfConsistent(artifact: StructuredFlowArtifact): boolean {
  const anyFailed = artifact.commands.some((command) => command.status === 'failed');
  if (artifact.flowStatus === 'passed') return !anyFailed;
  if (artifact.flowStatus === 'failed') return anyFailed;
  return false;
}

/**
 * Per-stage verb-class counting join. For each verb class: when the artifact
 * carries exactly as many entries as authored AND their statuses are uniform,
 * a bijection exists within the class and every row is proven with that status
 * (skipped ⇒ notRun). Any count mismatch or mixed statuses leaves individual
 * rows unknown — never resolved by position.
 */
function assignOutcomesFromArtifact(
  stageOperations: LedgerOperation[],
  artifact: StructuredFlowArtifact,
  stageId: string,
  observations: LedgerObservation[],
): void {
  recordObservations(stageOperations, artifact, stageId, observations);

  const authoredByVerb = new Map<string, LedgerOperation[]>();
  for (const operation of stageOperations) {
    const rows = authoredByVerb.get(operation.verb) ?? [];
    rows.push(operation);
    authoredByVerb.set(operation.verb, rows);
  }
  const observedByVerb = new Map<string, VerbClassEvidence>();
  for (const command of artifact.commands) {
    const evidence = observedByVerb.get(command.type) ?? { operationIds: [], statuses: [] };
    evidence.statuses.push(command.status);
    observedByVerb.set(command.type, evidence);
  }

  for (const [verb, rows] of authoredByVerb) {
    const statuses = observedByVerb.get(verb)?.statuses ?? [];
    // The pinned producer preallocates EVERY authored command (non-executed
    // ones as 'skipped'), so an entirely absent class is contract deviation,
    // not proof of notRun — those rows stay unknown like any other mismatch.
    if (statuses.length !== rows.length) continue; // absence/expansion/mismatch — unknown
    const uniform = statuses.every((status) => status === statuses[0]);
    if (!uniform) continue; // individual attribution unprovable — unknown
    const status = statuses[0];
    for (const row of rows) {
      row.outcome =
        status === 'passed'
          ? { state: 'proven', status: 'passed' }
          : status === 'failed'
            ? { state: 'proven', status: 'failed' }
            : status === 'skipped'
              ? { state: 'notRun' }
              : { state: 'unknown' };
    }
  }

  // An executed entry the authored plan cannot account for (mapping 'none', or
  // more entries than authored rows) taints the stage: the producer deviated
  // from the plan, so no row keeps a favorable proven-passed outcome.
  const deviated = artifact.commands.some((command) => {
    const rows = authoredByVerb.get(command.type);
    return !rows || (observedByVerb.get(command.type)?.statuses.length ?? 0) > rows.length;
  });
  if (deviated) {
    for (const row of stageOperations) {
      if (row.outcome.state === 'proven' && row.outcome.status === 'passed') {
        row.outcome = { state: 'unknown' };
      }
    }
  }
}

/**
 * Envelope-boundary validator: accepts only a structurally complete qualifier
 * (proven mutation evidence, coherent lineage, clean finalized terminations).
 */
export function isProvenTrailingVerificationQualifier(
  candidate: unknown,
): candidate is TrailingVerificationQualifier {
  const qualifier = candidate as TrailingVerificationQualifier | null | undefined;
  if (!qualifier || typeof qualifier !== 'object') return false;
  if (qualifier.trailingVerificationOnly !== true) return false;
  if (qualifier.mutationEvidence !== 'proven') return false;
  if (
    typeof qualifier.provenMutations !== 'number' ||
    qualifier.provenMutations < 1 ||
    typeof qualifier.failedVerifications !== 'number' ||
    qualifier.failedVerifications < 1
  ) {
    return false;
  }
  const attempt = qualifier.attempt;
  if (!attempt || typeof attempt.attemptId !== 'string' || attempt.attemptId.length === 0) {
    return false;
  }
  if (attempt.kind === 'repaired' && !attempt.parentAttemptId) return false;
  if (attempt.kind === 'initial' && attempt.parentAttemptId) return false;
  if (attempt.kind !== 'initial' && attempt.kind !== 'repaired') return false;
  if (!Array.isArray(qualifier.stageTerminations) || qualifier.stageTerminations.length === 0) {
    return false;
  }
  // Strict field typing: a missing or wrongly typed flag must read as dirty,
  // never as clean-by-absence.
  return qualifier.stageTerminations.every(
    (termination) =>
      termination !== null &&
      typeof termination === 'object' &&
      typeof termination.exitCode === 'number' &&
      Number.isFinite(termination.exitCode) &&
      termination.signal === null &&
      termination.timedOut === false &&
      termination.outputTruncated === false &&
      termination.bootstrapFailure === false &&
      termination.transportFailure === false &&
      termination.artifactFinalized === true,
  );
}

export interface TrailingVerificationQualifier {
  trailingVerificationOnly: true;
  mutationEvidence: 'proven';
  provenMutations: number;
  failedVerifications: number;
  notRunOperations: number;
  attempt: Pick<LedgerAttempt, 'attemptId' | 'ordinal' | 'kind' | 'parentAttemptId'>;
  /** Per-stage termination provenance, carried so the result/RunRecord block is self-contained. */
  stageTerminations: LedgerInvocationTermination[];
}

/**
 * THE classifier (initial and repaired attempts alike). Grants the qualifier
 * only when the ledger proves: attempt complete with clean termination on every
 * stage, every authored mutation proven-passed, at least one verification
 * proven-failed, and nothing failed outside verification effect. "Trailing"
 * needs no ordering evidence: a mid-flow verification failure leaves later
 * mutations notRun, which already withholds the qualifier.
 */
export function classifyTrailingVerification(
  ledger: MaestroRunLedger,
): TrailingVerificationQualifier | null {
  // Structure validation before anything else: a hand-built or deserialized
  // ledger must present the supported schema, at least one stage, and every
  // operation bound to an existing invoked stage.
  if (ledger.schemaVersion !== MAESTRO_RUN_LEDGER_SCHEMA_VERSION) return null;
  if (ledger.producerAdapterVersion !== MAESTRO_RUNNER_FLOW_JSON_ADAPTER) return null;
  if (ledger.stages.length === 0) return null;
  const stageById = new Map(ledger.stages.map((stage) => [stage.stageId, stage]));
  if (
    ledger.operations.some((operation) => {
      const stage = stageById.get(operation.stageId);
      return !stage || !stage.invoked;
    })
  ) {
    return null;
  }
  if (!ledger.attempt.complete) return null;
  if (ledger.operations.length === 0) return null;
  // Lineage guard: a repaired attempt that cannot name its parent is malformed
  // qualifier evidence, and an initial attempt must not claim one.
  if (ledger.attempt.kind === 'repaired' && !ledger.attempt.parentAttemptId) return null;
  if (ledger.attempt.kind === 'initial' && ledger.attempt.parentAttemptId) return null;
  // Defense in depth: never trust the complete flag alone — a deserialized or
  // hand-built ledger must still present clean termination on every stage.
  const stageTerminations: LedgerInvocationTermination[] = [];
  for (const stage of ledger.stages) {
    if (!stage.invoked || stage.invocationTermination === null) return null;
    if (!terminationClean(stage.invocationTermination)) return null;
    stageTerminations.push(stage.invocationTermination);
  }
  if (ledger.operations.some((operation) => operation.effect === 'unknown')) return null;
  if (ledger.operations.some((operation) => operation.outcome.state === 'unknown')) return null;

  // Producer-sequence proof that the failure actually terminated the mutating
  // portion: within each stage's own artifact ordering (producer-attributed,
  // never renderer-derived), no mutation may report success after the first
  // failure, and once a stage failed, no later stage may run mutations.
  let failureSeen = false;
  for (const stage of ledger.stages) {
    const stageObservations = ledger.observations.filter(
      (observation) =>
        observation.stageId === stage.stageId && observation.producer === 'maestro-commands-json',
    );
    const passedMutation = (observation: LedgerObservation): boolean =>
      observation.status === 'passed' && commandEffect(observation.command) === 'mutation';
    if (failureSeen && stageObservations.some(passedMutation)) return null;
    const failedSequences: number[] = [];
    for (const observation of stageObservations) {
      if (observation.status !== 'failed') continue;
      if (typeof observation.producerSequence !== 'number') return null;
      failedSequences.push(observation.producerSequence);
    }
    if (failedSequences.length > 0) {
      const firstFailure = Math.min(...failedSequences);
      const mutationAfterFailure = stageObservations.some(
        (observation) =>
          passedMutation(observation) &&
          (typeof observation.producerSequence !== 'number' ||
            observation.producerSequence > firstFailure),
      );
      if (mutationAfterFailure) return null;
      failureSeen = true;
    }
  }

  let provenMutations = 0;
  let failedVerifications = 0;
  let notRunOperations = 0;
  for (const operation of ledger.operations) {
    const { effect, outcome } = operation;
    if (outcome.state === 'notRun') {
      if (effect === 'mutation') return null; // a mutation never ran — not complete
      notRunOperations++;
      continue;
    }
    if (outcome.state === 'proven' && outcome.status === 'failed') {
      if (effect !== 'verification') return null; // a mutation/control failed
      failedVerifications++;
      continue;
    }
    if (effect === 'mutation') provenMutations++;
  }
  if (failedVerifications === 0) return null; // nothing failed — not a failure to qualify
  // A verification-only flow carries no completed mutation whose final state is
  // uncertain — the qualifier's claim would be vacuous, so withhold it.
  if (provenMutations === 0) return null;

  return {
    trailingVerificationOnly: true,
    mutationEvidence: 'proven',
    provenMutations,
    failedVerifications,
    notRunOperations,
    stageTerminations,
    attempt: {
      attemptId: ledger.attempt.attemptId,
      ordinal: ledger.attempt.ordinal,
      kind: ledger.attempt.kind,
      ...(ledger.attempt.parentAttemptId
        ? { parentAttemptId: ledger.attempt.parentAttemptId }
        : {}),
    },
  };
}
