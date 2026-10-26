import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ACTION_ENGINE_PIN,
  MAESTRO_RUNNER_PIN,
  exactPinRefusal,
  findRegexTextSelectors,
  meetsMaestroRunnerFloor,
  parseActionEnginePinVersion,
  type ReplayEngineStatus,
} from './engine-pin.js';
import { parseAndValidateFlow, MaestroValidationError } from './maestro-validator.js';
import { parseM7Header } from './reusable-action.js';
import {
  commitMigratedActionText,
  loadActionMigrationBaseline,
  captureActionFromPath,
  captureActionFromContext,
  openReadableActionLoadContext,
  splitYaml,
  joinYaml,
  resolveActionPath,
} from './action-store.js';

export type ReplayCompatibilityRefusalClass = 'runtimePin' | 'enginePin' | 'regexSelector';

export interface ReplayCompatibilityRefusal {
  message: string;
  refusalClass: ReplayCompatibilityRefusalClass;
}

export type LearnedActionRefusalClass = 'enginePin' | 'regexSelector' | 'unreadable';

export interface LearnedActionCompatReport {
  scanned: number;
  compatible: number;
  counts: Record<LearnedActionRefusalClass, number>;
  actionIds: Record<LearnedActionRefusalClass, string[]>;
}

export function actionEnginePinRefusal(enginePin: string | undefined): string | null {
  if (!enginePin) {
    return (
      `Action is not migrated to ${ACTION_ENGINE_PIN} or newer. Run ` +
      `node <qaren-runtime>/maestro-runner-pin.js migrate-actions --root <app> ` +
      `before replay. Incompatible actions are terminal — no manual fallback.`
    );
  }
  const version = parseActionEnginePinVersion(enginePin);
  if (!version) {
    return (
      `Action enginePin ${enginePin} is incompatible with the required floor ${ACTION_ENGINE_PIN}. ` +
      `Migrate or re-record the action. Incompatible actions are terminal — no manual fallback.`
    );
  }
  if (!meetsMaestroRunnerFloor(version)) {
    return (
      `Action enginePin ${enginePin} is below the required floor ${ACTION_ENGINE_PIN}. ` +
      `Migrate or re-record the action. Incompatible actions are terminal — no manual fallback.`
    );
  }
  return null;
}

export function regexSelectorCapabilityRefusal(commands: readonly unknown[]): string | null {
  const selectors = findRegexTextSelectors(commands);
  if (selectors.length === 0) return null;
  return (
    `Action uses regex text selectors (${selectors[0]}) which are not a validated ` +
    `maestro-runner ${MAESTRO_RUNNER_PIN.version} capability (GH #750 CONTAINS mistranslation). ` +
    `Rewrite as id or literal text selectors before replay. No UI mutation will run.`
  );
}

export function actionReplayPreflight(opts: {
  enginePin?: string;
  commands: readonly unknown[];
  engineStatus: ReplayEngineStatus | null;
  requireRuntimePin?: boolean;
}): string | null {
  return actionReplayRefusal(opts)?.message ?? null;
}

export function actionReplayRefusal(opts: {
  enginePin?: string;
  commands: readonly unknown[];
  engineStatus: ReplayEngineStatus | null;
  requireRuntimePin?: boolean;
}): ReplayCompatibilityRefusal | null {
  return replayCompatibilityRefusal({
    ...opts,
    requireEnginePin: true,
    requireRuntimePin: opts.requireRuntimePin,
  });
}

export function replayCompatibilityPreflight(opts: {
  enginePin?: string;
  commands: readonly unknown[];
  engineStatus: ReplayEngineStatus | null;
  requireEnginePin: boolean;
  requireRuntimePin?: boolean;
}): string | null {
  return replayCompatibilityRefusal(opts)?.message ?? null;
}

export function replayCompatibilityRefusal(opts: {
  enginePin?: string;
  commands: readonly unknown[];
  engineStatus: ReplayEngineStatus | null;
  requireEnginePin: boolean;
  requireRuntimePin?: boolean;
}): ReplayCompatibilityRefusal | null {
  if (opts.requireRuntimePin !== false) {
    const pin = exactPinRefusal(opts.engineStatus);
    if (pin) return { message: pin, refusalClass: 'runtimePin' };
  }
  // Migration cannot repair regex selectors, so report their terminal refusal first.
  const selectors = regexSelectorCapabilityRefusal(opts.commands);
  if (selectors) return { message: selectors, refusalClass: 'regexSelector' };
  if (opts.requireEnginePin) {
    const format = actionEnginePinRefusal(opts.enginePin);
    if (format) return { message: format, refusalClass: 'enginePin' };
  }
  return null;
}

export function isLearnedActionPath(path: string): boolean {
  return classifyLearnedActionPath(path) === 'action';
}

export function classifyLearnedActionPath(path: string): 'outside' | 'action' | 'descendant' {
  const lexical = classifyResolvedLearnedActionPath(resolve(path));
  try {
    const canonical = classifyResolvedLearnedActionPath(canonicalizeExistingPath(path));
    if (lexical === canonical) return lexical;
    if (lexical === 'outside') return canonical;
    return 'descendant';
  } catch {
    return lexical;
  }
}

function classifyResolvedLearnedActionPath(path: string): 'outside' | 'action' | 'descendant' {
  let parent = dirname(path);
  let direct = true;
  while (true) {
    if (basename(parent) === 'actions' && basename(dirname(parent)) === '.qaren') {
      return direct ? 'action' : 'descendant';
    }
    const next = dirname(parent);
    if (next === parent) return 'outside';
    parent = next;
    direct = false;
  }
}

function canonicalizeExistingPath(path: string): string {
  let cursor = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return cursor;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

export function standaloneLearnedActionPathRefusal(path: string): string | null {
  const classification = classifyLearnedActionPath(path);
  if (classification === 'outside') return null;
  if (classification === 'descendant') {
    return `Refusing to execute learned-action descendant ${path} as a standalone flow.`;
  }
  const actionId = basename(path).replace(/\.ya?ml$/i, '');
  try {
    const action = captureActionFromPath(path);
    if (!action) {
      return `Action ${actionId} does not resolve uniquely to ${path}.`;
    }
    if (!action.replay.ok) return action.replay.error;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return null;
}

const ENGINE_PIN_LINE = new RegExp(`^#\\s*enginePin\\s*:\\s*.+$`);

export function upsertEnginePinHeader(text: string): { text: string; changed: boolean } {
  const parts = splitYaml(text);
  const existing = parts.headerLines.filter((line) => ENGINE_PIN_LINE.test(line));
  const compatible = existing
    .map((line) => line.replace(/^#\s*enginePin\s*:\s*/, '').trim())
    .find((pin) => actionEnginePinRefusal(pin) === null);
  const nextLine = `# enginePin: ${compatible ?? ACTION_ENGINE_PIN}`;
  if (existing.length > 0) {
    const headerLines: string[] = [];
    let inserted = false;
    for (const line of parts.headerLines) {
      if (!ENGINE_PIN_LINE.test(line)) {
        headerLines.push(line);
      } else if (!inserted) {
        headerLines.push(nextLine);
        inserted = true;
      }
    }
    const nextText = joinYaml({ ...parts, headerLines });
    return { text: nextText, changed: nextText !== text };
  }
  const statusIdx = parts.headerLines.findIndex((line) => /^#\s*status\s*:/.test(line));
  const headerLines = [...parts.headerLines];
  if (statusIdx >= 0) headerLines.splice(statusIdx + 1, 0, nextLine);
  else headerLines.push(nextLine);
  return { text: joinYaml({ ...parts, headerLines }), changed: true };
}

export interface ActionMigrationResult {
  id: string;
  path: string;
  status: 'already-pinned' | 'migrated' | 'incompatible' | 'unreadable';
  reason?: string;
  mutated: boolean;
}

function isOwnedActionFile(name: string): boolean {
  return name.endsWith('.yaml') || name.endsWith('.yml');
}

function actionIdFromFile(name: string): string {
  return name.replace(/\.ya?ml$/, '');
}

function inheritedActionsCorpusReason(projectRoot: string): string | null {
  const rnAgentDir = join(projectRoot, '.qaren');
  const actionsDir = join(rnAgentDir, 'actions');
  try {
    if (lstatSync(rnAgentDir).isSymbolicLink()) {
      return (
        `Refusing to migrate through inherited .qaren symlink at ${rnAgentDir}. ` +
        `Symlink-inherited corpora are never modified.`
      );
    }
  } catch {
    return null;
  }
  try {
    if (lstatSync(actionsDir).isSymbolicLink()) {
      return (
        `Refusing to migrate through inherited .qaren/actions symlink at ${actionsDir}. ` +
        `Symlink-inherited corpora are never modified.`
      );
    }
  } catch {
    return null;
  }
  return null;
}

export function migrateLearnedActions(projectRoot: string): ActionMigrationResult[] {
  const dir = join(projectRoot, '.qaren', 'actions');
  const inherited = inheritedActionsCorpusReason(projectRoot);
  if (inherited) {
    return [
      {
        id: 'actions',
        path: dir,
        status: 'incompatible',
        reason: inherited,
        mutated: false,
      },
    ];
  }
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter(isOwnedActionFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    return [
      {
        id: 'actions',
        path: dir,
        status: 'unreadable',
        reason: err instanceof Error ? err.message : String(err),
        mutated: false,
      },
    ];
  }
  const results: ActionMigrationResult[] = [];
  for (const name of files) {
    const path = join(dir, name);
    const id = actionIdFromFile(name);
    try {
      const resolvedPath = resolveActionPath(projectRoot, id);
      if (resolvedPath !== path) {
        throw new Error(`Action ${id} does not resolve to ${path}.`);
      }
    } catch (err) {
      results.push({
        id,
        path,
        status: 'incompatible',
        reason: err instanceof Error ? err.message : String(err),
        mutated: false,
      });
      continue;
    }
    try {
      if (lstatSync(path).isSymbolicLink()) {
        results.push({
          id,
          path,
          status: 'incompatible',
          reason:
            `Refusing to migrate through inherited action symlink at ${path}. ` +
            `Symlink-inherited corpora are never modified.`,
          mutated: false,
        });
        continue;
      }
    } catch (err) {
      results.push({
        id,
        path,
        status: 'unreadable',
        reason: err instanceof Error ? err.message : String(err),
        mutated: false,
      });
      continue;
    }
    let baseline: ReturnType<typeof loadActionMigrationBaseline>;
    try {
      baseline = loadActionMigrationBaseline(path);
    } catch (err) {
      results.push({
        id,
        path,
        status: 'unreadable',
        reason: err instanceof Error ? err.message : String(err),
        mutated: false,
      });
      continue;
    }
    const text = baseline.yamlText;
    const meta = parseM7Header(text, id);
    if (!meta) {
      results.push({
        id,
        path,
        status: 'unreadable',
        reason: 'missing M7 id/intent',
        mutated: false,
      });
      continue;
    }
    if (meta.id !== id) {
      results.push({
        id,
        path,
        status: 'incompatible',
        reason: `Action metadata id ${meta.id} does not match filename identity ${id}.`,
        mutated: false,
      });
      continue;
    }
    let commands: unknown[] = [];
    try {
      commands = parseAndValidateFlow(text, { flowDir: dirname(path), flowRoot: dir }).commands;
    } catch (err) {
      const reason = err instanceof MaestroValidationError ? err.message : String(err);
      results.push({ id, path, status: 'unreadable', reason, mutated: false });
      continue;
    }
    const selectorRefusal = regexSelectorCapabilityRefusal(commands);
    if (selectorRefusal) {
      results.push({ id, path, status: 'incompatible', reason: selectorRefusal, mutated: false });
      continue;
    }
    const updated = upsertEnginePinHeader(text);
    if (updated.changed) {
      try {
        commitMigratedActionText(path, baseline, updated.text);
      } catch (err) {
        results.push({
          id,
          path,
          status: 'unreadable',
          reason: err instanceof Error ? err.message : String(err),
          mutated: false,
        });
        continue;
      }
    }
    results.push({
      id,
      path,
      status: updated.changed ? 'migrated' : 'already-pinned',
      mutated: updated.changed,
    });
  }
  return results;
}

function emptyLearnedActionCompatReport(): LearnedActionCompatReport {
  return {
    scanned: 0,
    compatible: 0,
    counts: { enginePin: 0, regexSelector: 0, unreadable: 0 },
    actionIds: { enginePin: [], regexSelector: [], unreadable: [] },
  };
}

export function diagnoseLearnedActions(projectRoot: string): LearnedActionCompatReport {
  const report = emptyLearnedActionCompatReport();
  let context: ReturnType<typeof openReadableActionLoadContext>;
  try {
    context = openReadableActionLoadContext(projectRoot, { includeRunFlowFiles: true });
  } catch {
    report.counts.unreadable = 1;
    report.actionIds.unreadable = ['actions'];
    return report;
  }
  if (!context) return report;

  const ids = [...new Set(context.files.filter(isOwnedActionFile).map(actionIdFromFile))].sort();
  report.scanned = ids.length;
  for (const id of ids) {
    let refusal: LearnedActionRefusalClass | null = 'unreadable';
    try {
      const captured = captureActionFromContext(context, id);
      if (captured?.metadata && captured.replay.ok) {
        if (regexSelectorCapabilityRefusal(captured.replay.commands)) refusal = 'regexSelector';
        else if (actionEnginePinRefusal(captured.metadata.enginePin)) refusal = 'enginePin';
        else refusal = null;
      }
    } catch {
      refusal = 'unreadable';
    }
    if (refusal === null) report.compatible += 1;
    else {
      report.counts[refusal] += 1;
      report.actionIds[refusal].push(id);
    }
  }
  return report;
}
