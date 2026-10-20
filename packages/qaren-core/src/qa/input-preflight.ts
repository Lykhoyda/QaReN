import { isAbsolute } from 'node:path';
import { loadBlock, readBlock } from './blocks.js';
import { collectInputInventory, planHash } from './plan.js';
import { RunInputs, withInputs } from './inputs.js';
import { ObservedPrivacy } from './privacy.js';
import { isRecord, type Judge } from './questions.js';
import { preflightPlan } from './preflight.js';

export interface LoginSnapshot {
  slug: string;
  content: string | null;
}

export function eligibleLogin(
  slug: string,
  content: string | null,
  appId: string,
  platform: string,
): LoginSnapshot {
  if (content !== null) {
    const stored = readBlock(content);
    if ('invalid' in stored || stored.header.appId !== appId || stored.header.platform !== platform)
      content = null;
  }
  return { slug, content };
}

export function ownedLogin(
  slug: string,
  appRoot: string,
  appId: string,
  platform: string,
): LoginSnapshot {
  let content: string | null = null;
  try {
    content = loadBlock(appRoot, slug);
  } catch {
    /* Unreadable blocks cannot replay. */
  }
  return eligibleLogin(slug, content, appId, platform);
}

export function inputInventory(
  plan: string,
  login?: LoginSnapshot,
): { requiredInputs: string[]; nonSecretInputs?: string[] } {
  const invalid = () => new Error('CORE_REFUSED: runtime input inventory refused');
  const scanned = collectInputInventory(plan);
  if (scanned.refused.length) throw invalid();
  const declarations = new Map(
    scanned.names.map((name) => [name, scanned.nonSecretInputs.includes(name)]),
  );
  if (login?.content) {
    const stored = readBlock(login.content);
    if ('invalid' in stored) throw invalid();
    for (const step of stored.steps) {
      if (step.input === undefined || step.kind !== 'fill') continue;
      const nonSecret = step.sensitivity === 'non-secret';
      if (declarations.has(step.input) && declarations.get(step.input) !== nonSecret)
        throw invalid();
      declarations.set(step.input, nonSecret);
    }
  }
  const nonSecretInputs = [...declarations]
    .filter(([, nonSecret]) => nonSecret)
    .map(([name]) => name)
    .sort();
  return {
    requiredInputs: [...declarations.keys()].sort(),
    ...(nonSecretInputs.length ? { nonSecretInputs } : {}),
  };
}

export function requiredInputs(plan: string, login?: LoginSnapshot): string[] {
  return inputInventory(plan, login).requiredInputs;
}

export function assertLoginPolicy(login: LoginSnapshot | undefined, inputs: RunInputs): void {
  if (!login?.content) return;
  const stored = readBlock(login.content);
  if ('invalid' in stored) throw new Error('CORE_REFUSED: runtime input inventory refused');
  const hash = stored.header.planHash;
  if (inputs.nonSecretNames().length || hash.startsWith('ns')) {
    if (
      (hash.includes(':') && !/^ns1:[a-f0-9]{64}$/.test(hash)) ||
      hash !== planHash(stored.steps, inputs.nonSecretNames())
    )
      throw new Error('CORE_REFUSED: saved login input policy refused');
  }
}

export async function parseInputPreflight(value: unknown, judge: Judge): Promise<object> {
  const invalid = () => new Error('CORE_REFUSED: runtime input preflight refused');
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.plan !== 'string' ||
    typeof value.appId !== 'string' ||
    !['ios', 'android'].includes(String(value.platform))
  )
    throw invalid();
  if (value.phase === 'input-inventory') {
    let loginSnapshot: LoginSnapshot | undefined;
    if (value.login !== undefined) {
      if (
        !isRecord(value.login) ||
        typeof value.login.slug !== 'string' ||
        !isRecord(value.login.source)
      )
        throw invalid();
      const source = value.login.source;
      if (
        source.kind === 'owned' &&
        typeof source.appRoot === 'string' &&
        isAbsolute(source.appRoot)
      )
        loginSnapshot = ownedLogin(
          value.login.slug,
          source.appRoot,
          value.appId,
          String(value.platform),
        );
      else if (
        source.kind === 'git' &&
        (source.content === null || typeof source.content === 'string')
      )
        loginSnapshot = eligibleLogin(
          value.login.slug,
          source.content,
          value.appId,
          String(value.platform),
        );
      else throw invalid();
    }
    return {
      ok: true,
      inputProtocol: 1,
      ...inputInventory(value.plan, loginSnapshot),
      ...(loginSnapshot ? { loginSnapshot } : {}),
    };
  }
  if (value.phase !== 'plan-preflight' || value.inputProtocol !== 1) throw invalid();
  let loginSnapshot: LoginSnapshot | undefined;
  if (value.loginSnapshot !== undefined) {
    const snap = value.loginSnapshot;
    if (
      !isRecord(snap) ||
      typeof snap.slug !== 'string' ||
      (snap.content !== null && typeof snap.content !== 'string') ||
      Object.keys(snap).sort().join(',') !== 'content,slug'
    )
      throw invalid();
    loginSnapshot = eligibleLogin(snap.slug, snap.content, value.appId, String(value.platform));
    if (loginSnapshot.content !== snap.content) throw invalid();
  }
  const inventory = inputInventory(value.plan, loginSnapshot);
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs(
    value.inputs,
    inventory.requiredInputs,
    privacy,
    inventory.nonSecretInputs,
  );
  return withInputs(inputs, async () => {
    assertLoginPolicy(loginSnapshot, inputs);
    inputs.assertHashSafe(value.appId as string);
    if (loginSnapshot?.content) inputs.assertHashSafe(loginSnapshot.content);
    return {
      ...(await preflightPlan(value.plan as string, judge)),
      inputProtocol: 1,
      ...inventory,
    };
  });
}
