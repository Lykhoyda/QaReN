// GH #384 (Story 03): tri-state quiescence-bypass status reported by the
// iOS rn-fast-runner at startup (see QuiescenceStatus.swift).
export type QuiescenceStatus = 'active' | 'disabled' | 'unavailable';

// Same rollout shape as the keyboard guard (runners/keyboard-guard.ts):
// default ON, opt out with RN_QUIESCENCE_BYPASS=0|false. Unlike the guard
// this is resolved once at runner SPAWN, not per command — the swizzle
// decision is process-wide inside the XCUITest runner.
export function resolveQuiescenceBypass(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.RN_QUIESCENCE_BYPASS ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

// xcodebuild only forwards TEST_RUNNER_-prefixed env vars to the XCUITest
// process (prefix stripped) — same lesson as buildRunnerVersionEnv (GH #383).
// The plain form covers any direct launch path.
export function buildRunnerQuiescenceEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const value = resolveQuiescenceBypass(env) ? '1' : '0';
  return {
    RN_QUIESCENCE_BYPASS: value,
    TEST_RUNNER_RN_QUIESCENCE_BYPASS: value,
  };
}
