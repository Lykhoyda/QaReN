import {
  assertReadableActionLoadContextStable,
  loadActionFromContext,
  openReadableActionLoadContext,
  type ReadableActionLoadContext,
} from './action-store.js';

export interface ActionSummary {
  id: string;
  intent: string;
  status: string;
  params?: string[];
  mutates?: boolean;
  appId?: string;
}

export interface ActionInventoryWarning {
  code: 'ACTION_INVENTORY_ENTRY_SKIPPED';
  file: string;
  message: string;
}

export interface ActionInventoryDependencies {
  loadAction?: (
    context: ReadableActionLoadContext,
    actionId: string,
  ) => ReturnType<typeof loadActionFromContext>;
  onWarning?: (warning: ActionInventoryWarning) => void;
}

function emitInventoryWarning(warning: ActionInventoryWarning): void {
  process.emitWarning(warning.message, {
    type: 'ActionInventoryWarning',
    code: warning.code,
  });
}

export async function listActions(
  projectRoot: string,
  dependencies: ActionInventoryDependencies = {},
): Promise<ActionSummary[]> {
  const context = openReadableActionLoadContext(projectRoot);
  if (!context) return [];
  const load = dependencies.loadAction ?? loadActionFromContext;
  const yamlFiles = context.files.filter((f) => /\.ya?ml$/.test(f)).sort();
  const results: ActionSummary[] = [];
  for (const id of new Set(yamlFiles.map((file) => file.replace(/\.ya?ml$/, '')))) {
    // Inventory omits yaml/yml twins; resolveActionPath still refuses replay.
    if (yamlFiles.includes(`${id}.yaml`) && yamlFiles.includes(`${id}.yml`)) continue;
    const file = yamlFiles.includes(`${id}.yaml`) ? `${id}.yaml` : `${id}.yml`;
    let action: ReturnType<typeof loadActionFromContext>;
    let failure: unknown;
    try {
      action = load(context, id);
      if (!action) failure = new Error('missing or invalid action metadata');
    } catch (error) {
      failure = error;
      action = null;
    }
    if (!action) {
      assertReadableActionLoadContextStable(context);
      const message = `Skipped corrupt action inventory entry ${file}: ${
        failure instanceof Error ? failure.message : String(failure)
      }`;
      (dependencies.onWarning ?? emitInventoryWarning)({
        code: 'ACTION_INVENTORY_ENTRY_SKIPPED',
        file,
        message,
      });
      continue;
    }
    const { metadata } = action;
    const summary: ActionSummary = {
      id: metadata.id,
      intent: metadata.intent,
      status: metadata.status,
    };
    if (metadata.params !== undefined) summary.params = metadata.params;
    if (metadata.mutates !== undefined) summary.mutates = metadata.mutates;
    if (metadata.appId !== undefined) summary.appId = metadata.appId;
    results.push(summary);
  }
  assertReadableActionLoadContextStable(context);
  return results;
}
