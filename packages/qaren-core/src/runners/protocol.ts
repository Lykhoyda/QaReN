import { readFileSync } from 'node:fs';
import type { RunIOSArgs } from './rn-fast-runner-client.js';
import type { RunAndroidArgs } from './rn-android-runner-client.js';
import { candidatePluginManifestFiles, firstExistingFile } from './runtime-paths.js';

// GH #383: the native runner /command wire protocol version. Mirrored by
// RunnerProtocol.swift (iOS) and RunnerProtocol.kt (Android); the tri-file
// sync test gh-383-protocol-sync.test.js enforces agreement. Bump when the
// wire shape changes incompatibly; raise MIN_SUPPORTED when old runners can
// no longer be driven.
export const RUNNER_PROTOCOL_VERSION = 2;
export const MIN_SUPPORTED_RUNNER_PROTOCOL = 1;

export type RunnerIncompatibilityReason =
  | 'legacy'
  | 'protocol-older'
  | 'protocol-newer'
  | 'version-skew'
  | 'missing-commands'
  | 'missing-features';

export type RunnerCompatibility =
  | { compatible: true }
  | { compatible: false; reason: RunnerIncompatibilityReason; missing?: string[] };

// GH #418: every wire verb the bridge can POST to each runner's /command —
// a curated subset of the client command unions (lifecycle/tvOS verbs are
// deliberately not gated). The satisfies tie makes a typo'd verb a compile
// error; gh-418-command-surface-sync.test.js enforces the native side.
export const REQUIRED_IOS_COMMANDS = [
  'tap',
  'type',
  // GH #581: exact post-settle fill verification. Gating on this command
  // rejects/rebuilds pre-#581 artifacts whose `type` still blind-types.
  'verifyInput',
  'drag',
  'longPress',
  'pinch',
  'snapshot',
  'screenshot',
  'back',
  'keyboardDismiss',
  'status',
] as const satisfies readonly RunIOSArgs['command'][];

export const REQUIRED_IOS_FEATURES = [
  'EXACT_KEYBOARD_TARGET_GUARD',
  'FILL_EVIDENCE_V1',
  'HIT_TESTED_DISPATCH_V1',
  'TARGET_FRAME_GUARD_V1',
  'SNAPSHOT_FIDELITY_V1',
  'SYSTEM_ALERT_TAP_V1',
] as const;

export const REQUIRED_ANDROID_FEATURES = [
  'APP_SCOPED_EXACT_INTERACTION',
  'FILL_EVIDENCE_V1',
] as const;

export const REQUIRED_ANDROID_COMMANDS = [
  'tap',
  'type',
  // GH #581: same exact-verification gate as iOS.
  'verifyInput',
  'drag',
  'longPress',
  'pinch',
  'snapshot',
  'screenshot',
  'back',
  'dismissKeyboard',
  'status',
] as const satisfies readonly RunAndroidArgs['command'][];

export function classifyRunnerCompatibility(
  health: {
    protocolVersion?: number;
    runnerVersion?: string;
    commands?: string[];
    capabilities?: string[];
  },
  pluginVersion: string | null,
  requiredCommands?: readonly string[],
  requiredFeatures?: readonly string[],
): RunnerCompatibility {
  if (health.protocolVersion === undefined) return { compatible: false, reason: 'legacy' };
  if (health.protocolVersion < MIN_SUPPORTED_RUNNER_PROTOCOL) {
    return { compatible: false, reason: 'protocol-older' };
  }
  if (health.protocolVersion > RUNNER_PROTOCOL_VERSION) {
    return { compatible: false, reason: 'protocol-newer' };
  }
  if (
    pluginVersion !== null &&
    health.runnerVersion !== undefined &&
    health.runnerVersion !== pluginVersion
  ) {
    return { compatible: false, reason: 'version-skew' };
  }
  // GH #418: strict on absence — an artifact that doesn't enumerate commands
  // predates enumeration and by definition predates any newer verb.
  if (requiredCommands !== undefined) {
    const advertised = new Set(health.commands ?? []);
    const missing = requiredCommands.filter((c) => !advertised.has(c));
    if (missing.length > 0) {
      return { compatible: false, reason: 'missing-commands', missing };
    }
  }
  if (requiredFeatures !== undefined) {
    const advertised = new Set(health.capabilities ?? []);
    const missing = requiredFeatures.filter((feature) => !advertised.has(feature));
    if (missing.length > 0) {
      return { compatible: false, reason: 'missing-features', missing };
    }
  }
  return { compatible: true };
}

// Fail-open plugin-version read: null when the manifest can't be read, which
// disables the version-skew check but never blocks a session.
let cachedPluginVersion: string | null | undefined;

export function getPluginVersion(): string | null {
  if (cachedPluginVersion !== undefined) return cachedPluginVersion;
  try {
    const manifestPath = firstExistingFile(candidatePluginManifestFiles());
    if (!manifestPath) {
      cachedPluginVersion = null;
      return cachedPluginVersion;
    }
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: string };
    cachedPluginVersion = typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    cachedPluginVersion = null;
  }
  return cachedPluginVersion;
}

export function _setPluginVersionForTest(v: string | null | undefined): void {
  cachedPluginVersion = v;
}
