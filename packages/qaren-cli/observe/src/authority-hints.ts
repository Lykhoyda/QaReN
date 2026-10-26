// Fallback recovery hints for typed authority refusals; map-only so a
// non-authority code is never dressed up as authority guidance.
const HINTS: Record<string, string> = {
  APP_INSTALL_IDENTITY_CHANGED:
    'bind install authority: run rn_session preview_integration, then apply_integration, then relaunch through the managed launcher',
  DEVICE_AUTHORITY_UNBOUND:
    'inspect the session authority: run rn_session status, then bind or repair the axis it names',
  DEVICE_AUTHORITY_MISMATCH:
    'bind the session device: run observe action=stop, then rn_session bind_device, then observe action=start',
  SESSION_AUTHORITY_REQUIRED: 'inspect the session: run rn_session status',
  SOURCE_WORKTREE_MISMATCH: 'inspect the bound source root: run rn_session status',
  METRO_AUTHORITY_MISMATCH:
    'bind Metro: run rn_session bind_metro with the session Metro instanceId',
  METRO_ORIGIN_MISMATCH:
    'relaunch the app through the managed launcher so it loads from the session Metro',
  BUNDLE_HANDSHAKE_UNAVAILABLE: 're-prove the exact session target: run cdp_connect',
  RUNNER_OWNERSHIP_MISMATCH: 'reopen the native runner: run device_snapshot action=open',
  PROOF_AUTHORITY_MISMATCH: 'inspect the proof run: run proof_capture action=status',
};

export function authorityRecoveryHint(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return HINTS[code];
}
