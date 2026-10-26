// GH #397 (Story 13 Phase 1): the tested maestro-runner pin.
//
// UPGRADE RITUAL (until the Story 06 golden-set harness automates it):
//   1. Install the candidate: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash -s -- --version <V>
//   2. Run the committed action corpus (cdp_run_e2e_suite) on iOS AND Android.
//   3. Reconcile knownQuirks (retest each listed quirk; add/remove entries).
//   4. Update version + sha256 here AND in ensure-maestro-runner.sh; add a changeset.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { verifiedNativePublicationHelper } from '../lifecycle/process-birth.js';
import { recordRunnerDiagnostic } from './runner-diagnostics.js';
import pinManifest from './maestro-runner-pin.json' with { type: 'json' };

interface MaestroRunnerPinManifest {
  readonly version: string;
  readonly sha256: Readonly<Partial<Record<string, string>>>;
  readonly archiveSha256: Readonly<Partial<Record<string, string>>>;
  readonly knownQuirks: ReadonlyArray<Readonly<{ id: string; ref: string; note: string }>>;
}

export const MAESTRO_RUNNER_PIN: MaestroRunnerPinManifest = Object.freeze({
  version: pinManifest.version,
  sha256: Object.freeze({ ...pinManifest.sha256 }),
  archiveSha256: Object.freeze({ ...pinManifest.archiveSha256 }),
  knownQuirks: Object.freeze(pinManifest.knownQuirks.map((quirk) => Object.freeze({ ...quirk }))),
});

const TRUSTED_DRIFT_SHA256 = Object.freeze({
  '1.0.9': Object.freeze({
    'darwin-arm64': '7d3777a67f8cc3d5e3927f498ddda8a56c424a10158f7cd4fa494ecc3ed97923',
    'darwin-x64': '36f8a973c3231b6b8125db4a3e131b8c3193aec6774145584b18070be979fd5f',
    'linux-arm64': 'a8e8197c63502fba874ce69b908174d46a47c6539025184e3003e70576d9451e',
    'linux-x64': 'bf7e9ef297c35712e9fad0ad56a65b7fd94e1f30168733cf09459b4ea80c4c3e',
  }),
});

export const ACTION_ENGINE_PIN = `maestro-runner@${MAESTRO_RUNNER_PIN.version}` as const;

const ACTION_ENGINE_PIN_RE = /^maestro-runner@(\d+(?:\.\d+)*)$/;

export function parseActionEnginePinVersion(enginePin: string): string | null {
  const match = ACTION_ENGINE_PIN_RE.exec(enginePin.trim());
  return match?.[1] ?? null;
}

const QAREN_RUNTIME_ROOT =
  '${QAREN_RUNTIME_ROOT:?set it to the installed qaren runtime root, then re-run}';

export const PINNED_RUNNER_INSTALL_HINT = `qaren doctor --install-runner` as const;

export const PINNED_RUNNER_DIAGNOSE_HINT =
  `node ${QAREN_RUNTIME_ROOT}/maestro-runner-pin.js diagnose` as const;

// GH #741: the pinned engine's bundled appium-uiautomator2-server APK declares
// minSdk 26, so pre-O devices reject it with INSTALL_FAILED_OLDER_SDK.
export const MAESTRO_RUNNER_MIN_ANDROID_API = 26;

const PRE_O_REMEDY =
  'Action replay / E2E via the maestro engine is unsupported on this device; the direct device_* ' +
  'interaction tier still works (rn-android-runner supports API 23+), except for the few device_* ' +
  'paths that fall back to maestro (dev-client picker and system dialogs), ' +
  'which hit this same limit.';

export type ReplayEngineTier = 'maestro-runner' | 'maestro' | 'maestro-cli';

function engineLabel(_runner: ReplayEngineTier): string {
  return `the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version}`;
}

export function preOAndroidApiRefusal(apiLevel: number): string | null {
  if (apiLevel >= MAESTRO_RUNNER_MIN_ANDROID_API) return null;
  return (
    `maestro_run refused: Android API ${apiLevel} is below API ${MAESTRO_RUNNER_MIN_ANDROID_API}, ` +
    `the minimum the pinned maestro-runner ${MAESTRO_RUNNER_PIN.version} can drive — its bundled ` +
    `UiAutomator2 server APK declares minSdk ${MAESTRO_RUNNER_MIN_ANDROID_API}, so the install ` +
    `fails with INSTALL_FAILED_OLDER_SDK. ${PRE_O_REMEDY}`
  );
}

const OLDER_SDK_TOKEN = /INSTALL_FAILED_OLDER_SDK/g;
// The token alone is not proof: `combined` also carries the app's own console
// and logcat output, and GH #249 already burned us with a bare `FAILED` scan.
// Require the SAME LINE to read like a package-install reject once the token
// itself (which contains INSTALL/FAILED) is stripped out.
const INSTALL_REJECT_CONTEXT = /\b(?:adb|install|installing|failure|uiautomator2)\b|\.apk\b/i;

export function isOlderSdkInstallFailure(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some(
      (line) =>
        line.includes('INSTALL_FAILED_OLDER_SDK') &&
        INSTALL_REJECT_CONTEXT.test(line.replace(OLDER_SDK_TOKEN, ' ')),
    );
}

export function olderSdkInstallDiagnosis(runner: ReplayEngineTier = 'maestro-runner'): string {
  return (
    `The device rejected the bundled UiAutomator2 server APK with INSTALL_FAILED_OLDER_SDK: ` +
    `${engineLabel(runner)} requires Android API ` +
    `${MAESTRO_RUNNER_MIN_ANDROID_API}+ and this device is below it. ${PRE_O_REMEDY}`
  );
}

export type EnginePinClassification =
  | 'pinned-ok'
  | 'unverified'
  | 'drift-newer'
  | 'drift-older'
  | 'checksum-mismatch'
  | 'unknown-version'
  | 'not-installed';

export interface EngineDetection {
  installed: boolean;
  version: string | null;
  sha256: string | null;
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function meetsMaestroRunnerFloor(version: string): boolean {
  return (
    /^\d+(?:\.\d+)*$/.test(version) && compareVersions(version, MAESTRO_RUNNER_PIN.version) >= 0
  );
}

export function classifyEnginePin(
  detected: EngineDetection,
  platformKey: string,
): EnginePinClassification {
  if (!detected.installed) return 'not-installed';
  if (!detected.version || !/^\d+(\.\d+)*$/.test(detected.version)) return 'unknown-version';
  if (compareVersions(detected.version, MAESTRO_RUNNER_PIN.version) < 0) return 'drift-older';
  const expected = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (!expected || !detected.sha256) return 'unverified';
  if (detected.sha256 !== expected) return 'checksum-mismatch';
  return 'pinned-ok';
}

export type RunnerProvenance = 'pin-cache' | 'none';

export interface ReplayEngineStatus {
  engine: 'maestro-runner' | 'none';
  version: string | null;
  pin: { pinned: string; status: EnginePinClassification };
  quirks: string[];
  selectedPath?: string | null;
  provenance?: RunnerProvenance;
}

export function pinCacheRoot(home = homedir()): string {
  const override = process.env.QAREN_RUNNER_CACHE;
  const base = override && override.length > 0 ? override : join(home, '.qaren', 'runtime');
  return resolve(base, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
}

export function pinnedRunnerBinPath(home?: string): string {
  return join(pinCacheRoot(home), 'bin', 'maestro-runner');
}

type PayloadEntry = { kind: 'file'; sha256: string } | { kind: 'symlink'; target: string };

function isPinCacheMetadataPath(relPath: string): boolean {
  return relPath
    .split(/[/\\]/)
    .some(
      (part) => part.startsWith('._') || part === 'PaxHeader' || part.startsWith('PaxHeaders.'),
    );
}

function tarText(buffer: Buffer, offset: number, length: number): string {
  const end = buffer.indexOf(0, offset);
  return buffer
    .subarray(offset, end >= offset && end < offset + length ? end : offset + length)
    .toString();
}

function expectedPayloadEntries(archive: Buffer): Map<string, PayloadEntry> | null {
  const tar = gunzipSync(archive, { maxOutputLength: 1024 * 1024 * 1024 });
  const raw: Array<{ path: string; type: string; data: Buffer; link: string }> = [];
  let offset = 0;
  let longPath: string | null = null;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const prefix = tarText(header, 345, 155);
    const name = tarText(header, 0, 100);
    const sizeText = tarText(header, 124, 12).trim();
    const size = Number.parseInt(sizeText || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) return null;
    const type = String.fromCharCode(header[156] || 48);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    const archivePath = longPath ?? [prefix, name].filter(Boolean).join('/');
    longPath = null;
    if (type === 'L') {
      longPath = data.toString().split('\u0000')[0].trim();
    } else if (type === '0' || type === '\0' || type === '2' || type === '5') {
      raw.push({ path: archivePath, type, data, link: tarText(header, 157, 100) });
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const runner = raw.find(
    (entry) =>
      (entry.type === '0' || entry.type === '\0') &&
      (entry.path === 'bin/maestro-runner' || entry.path.endsWith('/bin/maestro-runner')),
  );
  if (!runner) return null;
  const rootPrefix = runner.path.slice(0, -'bin/maestro-runner'.length);
  const expected = new Map<string, PayloadEntry>();
  for (const entry of raw) {
    if (!entry.path.startsWith(rootPrefix) || entry.type === '5') continue;
    const path = entry.path.slice(rootPrefix.length).replace(/^\.\//, '');
    if (!path || path.startsWith('/') || path.split('/').some((part) => part === '..')) return null;
    if (isPinCacheMetadataPath(path)) continue;
    if (entry.type === '2') {
      expected.set(path, { kind: 'symlink', target: entry.link });
    } else {
      expected.set(path, {
        kind: 'file',
        sha256: createHash('sha256').update(entry.data).digest('hex'),
      });
    }
  }
  return expected;
}

export function payloadMatchesPinnedArchive(
  root: string,
  archive: Buffer,
  expectedArchiveSha256: string,
): boolean {
  if (createHash('sha256').update(archive).digest('hex') !== expectedArchiveSha256) return false;
  const expected = expectedPayloadEntries(archive);
  if (!expected) return false;
  const seen = new Set<string>();
  const visit = (directory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (rel === '.payload.tar.gz' || isPinCacheMetadataPath(rel)) continue;
      if (entry.isDirectory()) {
        if (!visit(path)) return false;
        continue;
      }
      const wanted = expected.get(rel);
      if (!wanted) return false;
      seen.add(rel);
      if (entry.isSymbolicLink()) {
        if (wanted.kind !== 'symlink' || readlinkSync(path) !== wanted.target) return false;
        continue;
      }
      if (!entry.isFile() || wanted.kind !== 'file') return false;
      const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
      if (sha256 !== wanted.sha256) return false;
    }
    return true;
  };
  return visit(root) && seen.size === expected.size;
}

function installedPayloadMatchesPin(platformKey: string, root = pinCacheRoot()): boolean {
  try {
    const expectedArchiveSha = pinnedArchiveSha256(platformKey);
    if (!expectedArchiveSha) return false;
    const archive = readFileSync(join(root, '.payload.tar.gz'));
    return payloadMatchesPinnedArchive(root, archive, expectedArchiveSha);
  } catch {
    return false;
  }
}

function isRegularPinCacheBinary(path: string): boolean {
  try {
    const stat = lstatSync(path);
    const ancestors = [dirname(path), dirname(dirname(path)), dirname(dirname(dirname(path)))];
    const contained = ancestors.every((ancestor) => {
      const ancestorStat = lstatSync(ancestor);
      return ancestorStat.isDirectory() && !ancestorStat.isSymbolicLink();
    });
    accessSync(path, constants.X_OK);
    return contained && stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

export function getMaestroRunnerPath(): string | null {
  const path = pinnedRunnerBinPath();
  return isRegularPinCacheBinary(path) ? path : null;
}

function runnerCacheVersionsRoot(): string {
  return dirname(pinCacheRoot());
}

function pinCacheVersionForPath(path: string): string | null {
  if (!isRegularPinCacheBinary(path) || basename(path) !== 'maestro-runner') return null;
  const versionDir = dirname(dirname(resolve(path)));
  if (dirname(versionDir) !== resolve(runnerCacheVersionsRoot())) return null;
  const version = basename(versionDir);
  return /^\d+(?:\.\d+)*$/.test(version) ? version : null;
}

function getMaestroRunnerDetectionPath(): string | null {
  const exact = getMaestroRunnerPath();
  if (exact) return exact;
  const root = runnerCacheVersionsRoot();
  try {
    const candidates = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+(?:\.\d+)*$/.test(entry.name))
      .map((entry) => ({
        version: entry.name,
        path: join(root, entry.name, 'bin', 'maestro-runner'),
      }))
      .filter((candidate) => isRegularPinCacheBinary(candidate.path))
      .sort((left, right) => compareVersions(right.version, left.version));
    return candidates[0]?.path ?? null;
  } catch {
    return null;
  }
}

export function nodePlatformKey(platform = process.platform, arch = process.arch): string {
  return `${platform}-${arch}`;
}

export function pinArchiveCoords(
  platformKey: string,
): { os: 'darwin' | 'linux'; arch: 'arm64' | 'amd64' } | null {
  switch (platformKey) {
    case 'darwin-arm64':
      return { os: 'darwin', arch: 'arm64' };
    case 'darwin-x64':
      return { os: 'darwin', arch: 'amd64' };
    case 'linux-x64':
      return { os: 'linux', arch: 'amd64' };
    case 'linux-arm64':
      return { os: 'linux', arch: 'arm64' };
    default:
      return null;
  }
}

export function buildReplayEngineStatus(
  cls: EnginePinClassification,
  version: string | null,
  _cliPresent: boolean,
  extras: { selectedPath?: string | null; provenance?: RunnerProvenance } = {},
): ReplayEngineStatus {
  const engine = cls === 'pinned-ok' ? 'maestro-runner' : 'none';
  return {
    engine,
    version,
    pin: { pinned: MAESTRO_RUNNER_PIN.version, status: cls },
    quirks: MAESTRO_RUNNER_PIN.knownQuirks.map((q) => q.id),
    selectedPath: extras.selectedPath ?? null,
    provenance: extras.provenance ?? (cls === 'not-installed' ? 'none' : 'pin-cache'),
  };
}

export function enginePinCaveat(status: ReplayEngineStatus): string | null {
  const cls = status.pin.status;
  if (cls === 'drift-newer' || cls === 'drift-older') {
    return `maestro-runner ${status.version} differs from the tested pin ${status.pin.pinned} (untested drift — B223-class behavior changes arrive silently; see the upgrade ritual in engine-pin.ts)`;
  }
  if (cls === 'checksum-mismatch') {
    return `maestro-runner pin-cache binary checksum does not match the ${status.pin.pinned} manifest — possible corruption or tampering; reinstall via ensure-maestro-runner.sh`;
  }
  return null;
}

// GH #750 (B223-class): maestro-runner text selectors are regex. Any unescaped
// metacharacter — including the wildcard `.` in forms like `Log.n` — is
// unsupported here and must be rewritten as id or literal text before replay.
const REGEX_METACHARACTERS = new Set([
  '.',
  '^',
  '$',
  '*',
  '+',
  '?',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
]);

export function isRegexShapedSelector(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === '\\') return true;
    if (REGEX_METACHARACTERS.has(ch)) return true;
  }
  return false;
}

const TEXT_SELECTOR_KEYS = new Set([
  'tapOn',
  'doubleTapOn',
  'longPressOn',
  'assertVisible',
  'assertNotVisible',
  'copyTextFrom',
]);

const RELATIVE_SELECTOR_KEYS = new Set([
  'above',
  'below',
  'leftOf',
  'rightOf',
  'childOf',
  'containsChild',
  'containsDescendants',
]);

function selectorTextValues(value: unknown, found: string[]): void {
  if (typeof value === 'string') {
    if (isRegexShapedSelector(value)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) selectorTextValues(entry, found);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'text' || RELATIVE_SELECTOR_KEYS.has(key)) {
      selectorTextValues(nested, found);
    }
  }
}

function conditionTextValues(value: unknown, found: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'visible' || key === 'notVisible') selectorTextValues(nested, found);
  }
}

export function findRegexTextSelectors(commands: readonly unknown[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        if (TEXT_SELECTOR_KEYS.has(key)) selectorTextValues(nested, found);
        if (key === 'scrollUntilVisible' && nested && typeof nested === 'object') {
          selectorTextValues((nested as Record<string, unknown>).element, found);
        }
        if (key === 'extendedWaitUntil') conditionTextValues(nested, found);
        if (key === 'when') conditionTextValues(nested, found);
        visit(nested);
      }
    }
  };
  visit(commands);
  return found;
}

export function driftedRegexSelectorRefusal(
  status: ReplayEngineStatus | null,
  commands: readonly unknown[],
): string | null {
  const cls = status?.pin.status;
  if (cls !== 'drift-newer' && cls !== 'drift-older') return null;
  const selectors = findRegexTextSelectors(commands);
  if (selectors.length === 0) return null;
  return (
    `maestro_run refused: maestro-runner ${status!.version ?? 'unknown'} drifted from the tested pin ` +
    `${status!.pin.pinned} and the flow uses regex text selectors (${selectors[0]}). Drifted runners ` +
    `translate Maestro regex into a literal WDA CONTAINS predicate that can never match (B223-class, ` +
    `GH #750). Reinstall the pin via ensure-maestro-runner.sh, or rewrite the selectors as literal ` +
    `text or id selectors.`
  );
}

export function strictPinRefusal(
  status: ReplayEngineStatus | null,
  envValue: string | undefined,
): string | null {
  const strict = envValue === '1' || envValue === 'true';
  if (!strict || !status) return null;
  const cls = status.pin.status;
  if (cls !== 'drift-newer' && cls !== 'drift-older' && cls !== 'checksum-mismatch') return null;
  return `maestro_run refused: RN_ENGINE_PIN_STRICT is set and the engine pin status is ${cls} (installed ${status.version ?? 'unknown'}, pinned ${status.pin.pinned}). Reinstall the pin via ensure-maestro-runner.sh, or unset RN_ENGINE_PIN_STRICT.`;
}

export function pinCorrection(status: ReplayEngineStatus, platformKey = nodePlatformKey()): string {
  const cls = status.pin.status;
  const pinned = status.pin.pinned;
  const installed = status.version ?? 'unknown';
  const install = `Install attested ${pinned} (floor >= ${pinned}) via ${PINNED_RUNNER_INSTALL_HINT} (session pin-cache; do not use PATH or brew maestro).`;
  if (pinArchiveCoords(platformKey) === null) {
    return (
      `maestro-runner is unsupported on ${platformKey}. Supported platforms: darwin-arm64, darwin-x64, ` +
      `linux-x64, linux-arm64. ${install}`
    );
  }
  switch (cls) {
    case 'not-installed':
      return `Session maestro-runner ${pinned} is not installed. ${install}`;
    case 'drift-older':
      return `Session maestro-runner ${installed} is older than the required pin ${pinned}. ${install}`;
    case 'drift-newer':
      return `Session maestro-runner ${installed} is newer than the attested default ${pinned} and is not executed without attestation. ${install}`;
    case 'checksum-mismatch':
      return `Session maestro-runner binary checksum does not match the ${pinned} pin manifest. ${install}`;
    case 'unknown-version':
      return `Session maestro-runner version could not be read. ${install}`;
    case 'unverified':
      if (status.version && compareVersions(status.version, pinned) > 0) {
        return (
          `UNVERIFIED_NEWER_DRIFT: Session pin-cache contains an unverified newer maestro-runner entry ${installed}; ` +
          `its directory name is not trusted binary evidence and it will not be executed. ${install}`
        );
      }
      return `Session maestro-runner ${installed} could not be checksum-verified on ${platformKey}. ${install}`;
    case 'pinned-ok':
      return `Session maestro-runner ${pinned} is selected from the pin-cache.`;
  }
}

export function exactPinRefusal(
  status: ReplayEngineStatus | null,
  platformKey = nodePlatformKey(),
): string | null {
  // Execution stays pin-cache + attested 1.1.28 bytes. The product contract is a
  // floor (>= 1.1.28); unattested newer binaries remain non-executable.
  if (!status) {
    return `maestro_run refused: session runner ${MAESTRO_RUNNER_PIN.version} could not be detected. ${pinCorrection(buildReplayEngineStatus('not-installed', null, false), platformKey)}`;
  }
  if (status.pin.status === 'pinned-ok') return null;
  return `maestro_run refused: ${pinCorrection(status, platformKey)}`;
}

export async function immediateRunnerPinRefusal(
  runnerPath: string,
  resolveStatus: () => Promise<ReplayEngineStatus | null> = () =>
    getEngineStatus().catch(() => null),
): Promise<string | null> {
  const status = await resolveStatus();
  const refusal = exactPinRefusal(status);
  if (refusal) return `RUNNER_PIN_CHANGED: ${refusal}`;
  const canonicalPath = getMaestroRunnerPath();
  if (!canonicalPath || !status?.selectedPath) {
    return 'RUNNER_PIN_CHANGED: verified runner path disappeared before execution.';
  }
  if (
    resolve(canonicalPath) !== resolve(runnerPath) ||
    resolve(status.selectedPath) !== resolve(runnerPath)
  ) {
    return 'RUNNER_PIN_CHANGED: verified runner path changed before execution.';
  }
  return null;
}

export async function withBoundExecutable<T>(
  executablePath: string,
  expectedSha256: string,
  execute: (boundPath: string) => Promise<T>,
): Promise<T> {
  const boundPath = join(
    dirname(executablePath),
    `.maestro-runner.spawn.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  const original = lstatSync(executablePath);
  if (!original.isFile() || original.isSymbolicLink()) {
    throw new Error('RUNNER_PIN_CHANGED: executable identity changed before execution.');
  }
  copyFileSync(executablePath, boundPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  chmodSync(boundPath, original.mode & 0o777);
  try {
    const bound = lstatSync(boundPath);
    if (!bound.isFile() || bound.isSymbolicLink()) {
      throw new Error('RUNNER_PIN_CHANGED: executable identity changed before execution.');
    }
    const sha256 = createHash('sha256').update(readFileSync(boundPath)).digest('hex');
    if (sha256 !== expectedSha256) {
      throw new Error('RUNNER_PIN_CHANGED: executable content changed before execution.');
    }
    const execution = execute(boundPath);
    unlinkSync(boundPath);
    return await execution;
  } finally {
    try {
      unlinkSync(boundPath);
    } catch {}
  }
}

function copyPayloadTree(source: string, destination: string): void {
  const sourceStat = lstatSync(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`RUNNER_PIN_CHANGED: payload directory changed before execution.`);
  }
  mkdirSync(destination, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    const stat = lstatSync(sourcePath);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      copyPayloadTree(sourcePath, destinationPath);
      chmodSync(destinationPath, stat.mode & 0o777);
    } else if (stat.isFile() && !stat.isSymbolicLink()) {
      copyFileSync(
        sourcePath,
        destinationPath,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      chmodSync(destinationPath, stat.mode & 0o777);
    } else if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(sourcePath), destinationPath);
    } else {
      throw new Error(`RUNNER_PIN_CHANGED: unsupported payload entry ${sourcePath}.`);
    }
  }
}

export class RunnerCacheUnavailableError extends Error {
  readonly code = 'RUNNER_CACHE_UNAVAILABLE';

  constructor(
    readonly relativePath: 'cache',
    readonly errno: string,
  ) {
    super(`RUNNER_CACHE_UNAVAILABLE: ${relativePath}: ${errno}`);
    this.name = 'RunnerCacheUnavailableError';
  }
}

export function runnerCacheBootstrapFailure(error: RunnerCacheUnavailableError): string {
  return `WDA bootstrap could not provision its authority-bound runner cache: ${error.message}. No foreign cache path was changed; any cache directory created by this spawn was removed. Verify the runner cache parent is writable, then retry the exact replay.`;
}

function cacheErrno(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'UNKNOWN';
}

function expectedRunnerCacheRoot(snapshotRoot: string): string {
  const snapshotName = basename(snapshotRoot);
  const prefix = `.spawn-${MAESTRO_RUNNER_PIN.version}-`;
  if (!snapshotName.startsWith(prefix) || dirname(snapshotRoot) !== runnerCacheVersionsRoot()) {
    throw new RunnerCacheUnavailableError('cache', 'UNBOUND_SNAPSHOT');
  }
  return join(
    runnerCacheVersionsRoot(),
    `.wda-cache-${MAESTRO_RUNNER_PIN.version}-${snapshotName.slice(prefix.length)}`,
  );
}

export function assertRunnerSnapshotCacheBinding(snapshotRoot: string, cacheRoot: string): void {
  try {
    const expectedCacheRoot = expectedRunnerCacheRoot(snapshotRoot);
    if (resolve(cacheRoot) !== resolve(expectedCacheRoot)) {
      throw new RunnerCacheUnavailableError('cache', 'FOREIGN_PATH');
    }
    const cacheStat = lstatSync(cacheRoot);
    if (!cacheStat.isDirectory() || cacheStat.isSymbolicLink()) {
      throw new RunnerCacheUnavailableError('cache', 'INVALID_TARGET');
    }
    if ((cacheStat.mode & 0o777) !== 0o700) {
      throw new RunnerCacheUnavailableError('cache', 'UNSAFE_MODE');
    }
    const cacheLink = join(snapshotRoot, 'cache');
    if (!lstatSync(cacheLink).isSymbolicLink()) {
      throw new RunnerCacheUnavailableError('cache', 'NOT_LINKED');
    }
    if (realpathSync(cacheLink) !== realpathSync(cacheRoot)) {
      throw new RunnerCacheUnavailableError('cache', 'FOREIGN_PATH');
    }
  } catch (error) {
    if (error instanceof RunnerCacheUnavailableError) throw error;
    throw new RunnerCacheUnavailableError('cache', cacheErrno(error));
  }
}

let testWdaToolchainFingerprint: string | null | undefined;

export function _setWdaToolchainFingerprintForTest(fingerprint: string | null | undefined): void {
  testWdaToolchainFingerprint = fingerprint;
}

// Xcode/SDK identity fences the persistent store: a toolchain change lands in a
// fresh store slot and cold-builds instead of reusing artifacts of unknown drift.
// Probed on every call, never memoized: an xcode-select switch or in-place
// Xcode update must change the store key for the very next spawn.
function wdaToolchainFingerprint(): string | null {
  if (testWdaToolchainFingerprint !== undefined) return testWdaToolchainFingerprint;
  try {
    const probe = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8', timeout: 15_000 });
    const match = /Xcode\s+(\S+)[\s\S]*Build version\s+(\S+)/.exec(probe.stdout ?? '');
    return probe.status === 0 && match && /^[\w.]+$/.test(match[1]!) && /^[\w.]+$/.test(match[2]!)
      ? `xcode-${match[1]}-${match[2]}`
      : null;
  } catch {
    return null;
  }
}

export function persistentWdaStoreBuildsRoot(
  platformKey = nodePlatformKey(),
  fingerprint = wdaToolchainFingerprint(),
): string | null {
  if (!fingerprint || !pinArchiveCoords(platformKey)) return null;
  const versionsRoot = runnerCacheVersionsRoot();
  const components = [
    join(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`),
    join(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`, platformKey),
    join(versionsRoot, `.wda-store-${MAESTRO_RUNNER_PIN.version}`, platformKey, fingerprint),
    join(
      versionsRoot,
      `.wda-store-${MAESTRO_RUNNER_PIN.version}`,
      platformKey,
      fingerprint,
      'wda-builds',
    ),
  ];
  // Symlink fence: an existing component that is not a real directory would
  // redirect seeding, publication, and eviction outside the store tree.
  for (const component of components) {
    try {
      const stat = lstatSync(component);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    } catch {
      break;
    }
  }
  return components[3]!;
}

type WdaPlutil = (args: ReadonlyArray<string>) => {
  readonly status: number | null;
  readonly stdout?: string;
};

let testWdaPlutil: WdaPlutil | undefined;

export function _setWdaPlutilForTest(plutil: WdaPlutil | undefined): void {
  testWdaPlutil = plutil;
}

function runWdaPlutil(args: ReadonlyArray<string>): string | null {
  if (process.platform !== 'darwin' && !testWdaPlutil) return null;
  try {
    const result = testWdaPlutil
      ? testWdaPlutil(args)
      : spawnSync('plutil', [...args], { encoding: 'utf8', timeout: 15_000 });
    return result.status === 0 ? (result.stdout ?? '') : null;
  } catch {
    return null;
  }
}

function readWdaXctestrun(xctestrunPath: string): Record<string, unknown> | null {
  const json = runWdaPlutil(['-convert', 'json', '-o', '-', xctestrunPath]);
  if (json === null) return null;
  try {
    const plist: unknown = JSON.parse(json);
    return plist !== null && typeof plist === 'object' && !Array.isArray(plist)
      ? (plist as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asWdaPlistRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function forEachWdaTestTarget(
  plist: Record<string, unknown>,
  visit: (target: Record<string, unknown>) => void,
): void {
  const configurations = plist.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      const configurationRecord = asWdaPlistRecord(configuration);
      if (!configurationRecord) continue;
      const targets = configurationRecord.TestTargets;
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        const targetRecord = asWdaPlistRecord(target);
        if (targetRecord) visit(targetRecord);
      }
    }
    return;
  }
  for (const [key, target] of Object.entries(plist)) {
    const targetRecord = asWdaPlistRecord(target);
    if (key !== '__xctestrun_metadata__' && targetRecord) visit(targetRecord);
  }
}

function findWdaTestTarget(plist: Record<string, unknown>): Record<string, unknown> | null {
  const configurations = plist.TestConfigurations;
  if (Array.isArray(configurations)) {
    for (const configuration of configurations) {
      const targets = asWdaPlistRecord(configuration)?.TestTargets;
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        const targetRecord = asWdaPlistRecord(target);
        if (
          targetRecord &&
          (targetRecord.TestTargetName === 'WebDriverAgentRunner' ||
            targetRecord.BlueprintName === 'WebDriverAgentRunner')
        ) {
          return targetRecord;
        }
      }
    }
    return null;
  }
  return asWdaPlistRecord(plist.WebDriverAgentRunner);
}

function hasInjectedWdaPort(plist: Record<string, unknown>): boolean {
  let found = false;
  forEachWdaTestTarget(plist, (target) => {
    const environment = target.EnvironmentVariables;
    if (
      environment !== null &&
      typeof environment === 'object' &&
      !Array.isArray(environment) &&
      Object.hasOwn(environment, 'USE_PORT')
    ) {
      found = true;
    }
  });
  return found;
}

function isWithinWdaKey(keyDir: string, candidate: string): boolean {
  const path = relative(keyDir, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isContainedWdaProductTree(keyDir: string, products: string): boolean {
  const lexicalKey = resolve(keyDir);
  const realKey = realpathSync(keyDir);
  const visit = (directory: string): boolean => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (
          isAbsolute(target) ||
          !isWithinWdaKey(lexicalKey, resolve(directory, target)) ||
          !isWithinWdaKey(realKey, realpathSync(path))
        ) {
          return false;
        }
      } else if (stat.isDirectory() && !visit(path)) {
        return false;
      }
    }
    return true;
  };
  return visit(products);
}

function resolveWdaProductReference(
  reference: unknown,
  products: string,
  testHost?: string,
): string | null {
  if (typeof reference !== 'string') return null;
  if (reference.startsWith('__TESTROOT__/')) {
    return resolve(products, reference.slice('__TESTROOT__/'.length));
  }
  if (testHost && reference.startsWith('__TESTHOST__/')) {
    return resolve(testHost, reference.slice('__TESTHOST__/'.length));
  }
  return null;
}

interface CompleteWdaBuildManifest {
  readonly products: string;
  readonly selectedXctestrun: string;
}

function readCompleteWdaBuildManifest(keyDir: string): CompleteWdaBuildManifest | null {
  try {
    const derivedData = join(keyDir, 'DerivedData');
    const build = join(derivedData, 'Build');
    const products = join(build, 'Products');
    if (
      !isRealDirectory(keyDir) ||
      !isRealDirectory(derivedData) ||
      !isRealDirectory(build) ||
      !isRealDirectory(products) ||
      !isContainedWdaProductTree(keyDir, products)
    ) {
      return null;
    }
    const selected = readdirSync(products, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.xctestrun'))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))[0];
    if (!selected?.isFile()) return null;
    const selectedXctestrun = join(products, selected.name);
    const plist = readWdaXctestrun(selectedXctestrun);
    const target = plist && findWdaTestTarget(plist);
    if (!target) return null;

    const testHost = resolveWdaProductReference(target.TestHostPath, products);
    if (!testHost) return null;
    const hostPath = relative(products, testHost).split(sep);
    if (
      hostPath.length !== 2 ||
      hostPath[1] !== 'WebDriverAgentRunner-Runner.app' ||
      !isRealDirectory(join(products, hostPath[0]!)) ||
      !isRealDirectory(testHost)
    ) {
      return null;
    }
    const executable = lstatSync(join(testHost, 'WebDriverAgentRunner-Runner'));
    if (!executable.isFile() || executable.isSymbolicLink() || (executable.mode & 0o111) === 0) {
      return null;
    }
    const testBundle = resolveWdaProductReference(target.TestBundlePath, products, testHost);
    if (
      !testBundle ||
      !isWithinWdaKey(resolve(keyDir), testBundle) ||
      !isRealDirectory(testBundle)
    ) {
      return null;
    }
    const bundleExecutable = lstatSync(join(testBundle, 'WebDriverAgentRunner'));
    if (
      !bundleExecutable.isFile() ||
      bundleExecutable.isSymbolicLink() ||
      (bundleExecutable.mode & 0o111) === 0
    ) {
      return null;
    }
    return { products, selectedXctestrun };
  } catch {
    return null;
  }
}

// Build-for-testing emits the .xctestrun after its products exist; require the
// exact real host and bundle executables so torn or partial builds never qualify.
export function isCompleteWdaBuild(keyDir: string): boolean {
  return readCompleteWdaBuildManifest(keyDir) !== null;
}

function removeInjectedWdaPort(xctestrunPath: string): boolean {
  const plist = readWdaXctestrun(xctestrunPath);
  if (!plist) return false;
  forEachWdaTestTarget(plist, (target) => {
    const environment = target.EnvironmentVariables;
    if (environment !== null && typeof environment === 'object' && !Array.isArray(environment)) {
      delete (environment as Record<string, unknown>).USE_PORT;
    }
  });
  writeFileSync(xctestrunPath, JSON.stringify(plist, null, 2));
  return runWdaPlutil(['-convert', 'xml1', xctestrunPath]) !== null;
}

function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function copyReusableWdaBuild(sourceKey: string, stagedKey: string): boolean {
  const manifest = readCompleteWdaBuildManifest(sourceKey);
  if (!manifest) return false;
  const sourceProducts = manifest.products;
  const stagedProducts = join(stagedKey, 'DerivedData', 'Build', 'Products');
  mkdirSync(dirname(stagedProducts), { recursive: true });
  cpSync(sourceProducts, stagedProducts, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
    verbatimSymlinks: true,
  });
  for (const entry of readdirSync(stagedProducts, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.endsWith('.xctestrun') &&
      !removeInjectedWdaPort(join(stagedProducts, entry.name))
    ) {
      return false;
    }
  }
  return isCompleteWdaBuild(stagedKey);
}

function isReusableStoredWdaBuild(keyDir: string): boolean {
  try {
    if (!isCompleteWdaBuild(keyDir)) return false;
    const keyEntries = readdirSync(keyDir, { withFileTypes: true });
    const derivedData = keyEntries[0];
    if (
      keyEntries.length !== 1 ||
      derivedData?.name !== 'DerivedData' ||
      !derivedData.isDirectory()
    ) {
      return false;
    }
    const derivedDataEntries = readdirSync(join(keyDir, 'DerivedData'), { withFileTypes: true });
    const build = derivedDataEntries[0];
    if (derivedDataEntries.length !== 1 || build?.name !== 'Build' || !build.isDirectory()) {
      return false;
    }
    const buildEntries = readdirSync(join(keyDir, 'DerivedData', 'Build'), {
      withFileTypes: true,
    });
    const productsEntry = buildEntries[0];
    if (
      buildEntries.length !== 1 ||
      productsEntry?.name !== 'Products' ||
      !productsEntry.isDirectory()
    ) {
      return false;
    }
    const products = join(keyDir, 'DerivedData', 'Build', 'Products');
    return readdirSync(products, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith('.xctestrun'))
      .every((entry) => {
        if (!entry.isFile()) return false;
        const plist = readWdaXctestrun(join(products, entry.name));
        return plist !== null && !hasInjectedWdaPort(plist);
      });
  } catch {
    return false;
  }
}

function seedRunnerSnapshotCacheFromStore(cacheRoot: string, fingerprint: string | null): number {
  let seeded = 0;
  try {
    const storeBuilds = persistentWdaStoreBuildsRoot(nodePlatformKey(), fingerprint);
    if (!storeBuilds) return 0;
    const target = join(cacheRoot, 'wda-builds');
    for (const entry of readdirSync(storeBuilds, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceKey = join(storeBuilds, entry.name);
      if (!isCompleteWdaBuild(sourceKey)) continue;
      mkdirSync(target, { recursive: true });
      const stagedKey = join(target, `.seed-${entry.name}`);
      try {
        if (copyReusableWdaBuild(sourceKey, stagedKey)) {
          renameSync(stagedKey, join(target, entry.name));
          seeded += 1;
        } else {
          rmSync(stagedKey, { recursive: true, force: true });
        }
      } catch {
        try {
          rmSync(stagedKey, { recursive: true, force: true });
        } catch {}
      }
    }
  } catch {}
  return seeded;
}

function publishRunnerSnapshotCacheToStore(cacheRoot: string, fingerprint: string | null): number {
  let published = 0;
  try {
    const spawnBuilds = join(cacheRoot, 'wda-builds');
    const storeBuilds = persistentWdaStoreBuildsRoot(nodePlatformKey(), fingerprint);
    if (!storeBuilds) return 0;
    for (const entry of readdirSync(spawnBuilds, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const sourceKey = join(spawnBuilds, entry.name);
      if (!isCompleteWdaBuild(sourceKey)) continue;
      const storeKey = join(storeBuilds, entry.name);
      if (isReusableStoredWdaBuild(storeKey)) continue;
      mkdirSync(storeBuilds, { recursive: true, mode: 0o700 });
      const stage = mkdtempSync(join(storeBuilds, '.stage-'));
      try {
        const stagedKey = join(stage, entry.name);
        if (copyReusableWdaBuild(sourceKey, stagedKey)) {
          if (existsSync(storeKey)) {
            // Atomic evict: readers never observe a half-deleted key path.
            const evicted = join(stage, 'evicted');
            renameSync(storeKey, evicted);
          }
          // No-clobber claim: a concurrent publisher that recreated the key
          // wins (rename throws) and this spawn's copy is discarded with stage.
          renameSync(stagedKey, storeKey);
          published += 1;
        }
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
  } catch {}
  return published;
}

export interface RunnerSnapshotTestHooks {
  beforeCacheProvision?: (expectedCacheRoot: string) => void;
  beforeCacheBinding?: (ownedCacheRoot: string) => void;
}

function provisionRunnerSnapshotCache(
  snapshotRoot: string,
  testHooks: RunnerSnapshotTestHooks = {},
  setOwnedCacheRoot: (cacheRoot: string | null) => void = () => {},
): string {
  const cacheRoot = expectedRunnerCacheRoot(snapshotRoot);
  let ownsCacheRoot = false;
  try {
    testHooks.beforeCacheProvision?.(cacheRoot);
    mkdirSync(cacheRoot, { mode: 0o700 });
    ownsCacheRoot = true;
    setOwnedCacheRoot(cacheRoot);
    chmodSync(cacheRoot, 0o700);
    testHooks.beforeCacheBinding?.(cacheRoot);
    symlinkSync(cacheRoot, join(snapshotRoot, 'cache'), 'dir');
    assertRunnerSnapshotCacheBinding(snapshotRoot, cacheRoot);
    return cacheRoot;
  } catch (error) {
    const failure =
      error instanceof RunnerCacheUnavailableError
        ? error
        : new RunnerCacheUnavailableError('cache', cacheErrno(error));
    if (ownsCacheRoot) {
      try {
        rmSync(cacheRoot, { recursive: true, force: true });
        setOwnedCacheRoot(null);
      } catch (cleanupError) {
        throw new RunnerCacheUnavailableError(
          'cache',
          `${failure.errno}_CLEANUP_${cacheErrno(cleanupError)}`,
        );
      }
    }
    throw failure;
  }
}

function removeRunnerSnapshotAndCache(snapshotRoot: string, cacheRoot: string | null): void {
  let cleanupError: unknown;
  try {
    rmSync(snapshotRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (cacheRoot) {
    try {
      rmSync(cacheRoot, { recursive: true, force: true });
    } catch (error) {
      cleanupError ??= error;
    }
  }
  recordRunnerDiagnostic('cleanup', {
    snapshotRemoved: !existsSync(snapshotRoot),
    cacheRemoved: cacheRoot === null || !existsSync(cacheRoot),
  });
  if (cleanupError) throw cleanupError;
}

export async function withImmediatePinnedRunner<T>(
  runnerPath: string,
  resolveStatus: () => Promise<ReplayEngineStatus | null>,
  execute: (boundPath: string, prefixArgs?: readonly string[]) => Promise<T>,
  platform: 'ios' | 'android',
  testHooks: RunnerSnapshotTestHooks = {},
): Promise<T> {
  const refusal = await immediateRunnerPinRefusal(runnerPath, resolveStatus);
  if (refusal) throw new Error(refusal);
  const expectedSha256 = pinnedSha256(nodePlatformKey());
  if (!expectedSha256) {
    throw new Error('RUNNER_PIN_CHANGED: runner checksum is unavailable for this platform.');
  }
  const wdaStoreFingerprint = platform === 'ios' ? wdaToolchainFingerprint() : null;
  const snapshotRoot = mkdtempSync(
    join(runnerCacheVersionsRoot(), `.spawn-${MAESTRO_RUNNER_PIN.version}-`),
  );
  let cacheRoot: string | null = null;
  recordRunnerDiagnostic('spawn-begin', {
    snapshotId: basename(snapshotRoot),
    runnerPinVersion: MAESTRO_RUNNER_PIN.version,
  });
  try {
    copyPayloadTree(pinCacheRoot(), snapshotRoot);
    const snapshotRunner = join(snapshotRoot, 'bin', 'maestro-runner');
    const snapshotStat = lstatSync(snapshotRunner);
    if (
      !snapshotStat.isFile() ||
      snapshotStat.isSymbolicLink() ||
      !installedPayloadMatchesPin(nodePlatformKey(), snapshotRoot) ||
      createHash('sha256').update(readFileSync(snapshotRunner)).digest('hex') !== expectedSha256
    ) {
      recordRunnerDiagnostic('payload-verify', { result: 'failed' });
      throw new Error('RUNNER_PIN_CHANGED: payload content changed before execution.');
    }
    recordRunnerDiagnostic('payload-verify', {
      result: 'passed',
      runnerPinVersion: MAESTRO_RUNNER_PIN.version,
      provenance: 'pin-cache',
      payloadShaPrefix: expectedSha256.slice(0, 12),
    });
    const helper = verifiedNativePublicationHelper();
    const snapshotHelper = join(snapshotRoot, '.runner-exec');
    copyFileSync(helper.path, snapshotHelper, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    chmodSync(snapshotHelper, 0o500);
    if (createHash('sha256').update(readFileSync(snapshotHelper)).digest('hex') !== helper.sha256) {
      throw new Error('RUNNER_PIN_CHANGED: execution binding changed before execution.');
    }
    if (platform === 'ios') {
      try {
        cacheRoot = provisionRunnerSnapshotCache(snapshotRoot, testHooks, (ownedCacheRoot) => {
          cacheRoot = ownedCacheRoot;
        });
        recordRunnerDiagnostic('cache-provision', {
          result: 'passed',
          variant: 'symlink',
          resolvedPath: '../' + basename(cacheRoot),
        });
      } catch (error) {
        const failure =
          error instanceof RunnerCacheUnavailableError
            ? error
            : new RunnerCacheUnavailableError('cache', cacheErrno(error));
        recordRunnerDiagnostic('cache-provision', {
          result: 'failed',
          variant: 'symlink',
          resolvedPath: 'cache',
          errno: failure.errno,
        });
        recordRunnerDiagnostic('typed-failure', {
          code: failure.code,
          errno: failure.errno,
          path: failure.relativePath,
        });
        throw failure;
      }
    }
    for (const entry of readdirSync(snapshotRoot, { recursive: true, withFileTypes: true })) {
      const entryPath = join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) chmodSync(entryPath, 0o500);
      else if (entry.isFile()) {
        const executable =
          entryPath === snapshotRunner ||
          entryPath === snapshotHelper ||
          (lstatSync(entryPath).mode & 0o111) !== 0;
        chmodSync(entryPath, executable ? 0o500 : 0o400);
      }
    }
    chmodSync(snapshotRoot, 0o500);
    if (cacheRoot) {
      assertRunnerSnapshotCacheBinding(snapshotRoot, cacheRoot);
      // Seed strictly after sealing: the recursive seal walk descends through
      // the cache symlink, and sealed seed content breaks the runner's own
      // xctestrun port rewrite on the warm path.
      recordRunnerDiagnostic('cache-seed', {
        seededBuilds: seedRunnerSnapshotCacheFromStore(cacheRoot, wdaStoreFingerprint),
      });
    }
    const openedRunner = lstatSync(snapshotRunner);
    recordRunnerDiagnostic('runner-exec-begin', { runnerPinVersion: MAESTRO_RUNNER_PIN.version });
    if (platform === 'ios') {
      recordRunnerDiagnostic('wda-bootstrap-begin', { cachePath: 'cache' });
    }
    return await execute(snapshotHelper, [
      '--exec-file',
      snapshotRunner,
      String(openedRunner.dev),
      String(openedRunner.ino),
      '--',
    ]);
  } finally {
    if (cacheRoot) {
      const currentWdaFingerprint = platform === 'ios' ? wdaToolchainFingerprint() : null;
      recordRunnerDiagnostic('cache-publish', {
        publishedBuilds:
          wdaStoreFingerprint !== null && currentWdaFingerprint === wdaStoreFingerprint
            ? publishRunnerSnapshotCacheToStore(cacheRoot, wdaStoreFingerprint)
            : 0,
      });
    }
    try {
      chmodSync(snapshotRoot, 0o700);
      for (const entry of readdirSync(snapshotRoot, { recursive: true, withFileTypes: true })) {
        const entryPath = join(entry.parentPath, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) chmodSync(entryPath, 0o700);
        else if (entry.isFile()) chmodSync(entryPath, 0o600);
      }
    } catch {}
    removeRunnerSnapshotAndCache(snapshotRoot, cacheRoot);
  }
}

export interface PinDoctorReport {
  ok: boolean;
  status: EnginePinClassification;
  platformStatus: 'supported' | 'unsupported';
  platformKey: string;
  pinned: string;
  installedVersion: string | null;
  selectedPath: string | null;
  provenance: RunnerProvenance;
  correction: string | null;
  iosProofPolicy: {
    exactTestId: 'react-tree';
    nativeSurface: 'xctest-native';
    nativeBlindRefusal: 'NATIVE_SURFACE_BLIND';
    runtimeVersionHeuristicIsProof: false;
  };
}

export function doctorPinnedRunner(
  status: ReplayEngineStatus,
  platformKey = nodePlatformKey(),
): PinDoctorReport {
  const platformStatus = pinArchiveCoords(platformKey) === null ? 'unsupported' : 'supported';
  const ok = status.pin.status === 'pinned-ok' && platformStatus === 'supported';
  return {
    ok,
    status: status.pin.status,
    platformStatus,
    platformKey,
    pinned: status.pin.pinned,
    installedVersion: status.version,
    selectedPath: status.selectedPath ?? null,
    provenance: status.provenance ?? (status.pin.status === 'not-installed' ? 'none' : 'pin-cache'),
    correction: ok ? null : pinCorrection(status, platformKey),
    iosProofPolicy: {
      exactTestId: 'react-tree',
      nativeSurface: 'xctest-native',
      nativeBlindRefusal: 'NATIVE_SURFACE_BLIND',
      runtimeVersionHeuristicIsProof: false,
    },
  };
}

export interface EngineStatusResolvers {
  binPath?: () => string | null;
  execVersion?: (bin: string) => Promise<string>;
  hashFile?: (bin: string) => string | null;
  cliPresent?: () => boolean;
  platformKey?: string;
}

let testStatus: ReplayEngineStatus | undefined;
let testAttestation: { readonly sha256: string; readonly archiveSha256: string } | undefined;

function pinnedSha256(platformKey: string): string | undefined {
  return testAttestation?.sha256 ?? MAESTRO_RUNNER_PIN.sha256[platformKey];
}

function pinnedArchiveSha256(platformKey: string): string | undefined {
  return testAttestation?.archiveSha256 ?? MAESTRO_RUNNER_PIN.archiveSha256[platformKey];
}

export function _resetEngineStatusForTest(): void {
  testStatus = undefined;
  testAttestation = undefined;
}

export function _setEngineStatusForTest(s: ReplayEngineStatus): void {
  testStatus = s;
}

export function _setPinnedRunnerAttestationForTest(attestation: {
  sha256: string;
  archiveSha256: string;
}): void {
  testAttestation = attestation;
}

function defaultHashFile(bin: string): string | null {
  return createHash('sha256').update(readFileSync(bin)).digest('hex');
}

async function detect(resolvers: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  const binPath = (resolvers.binPath ?? getMaestroRunnerDetectionPath)();
  const platformKey = resolvers.platformKey ?? nodePlatformKey();
  if (!binPath) {
    return buildReplayEngineStatus('not-installed', null, false, {
      selectedPath: null,
      provenance: 'none',
    });
  }
  const cacheVersion = pinCacheVersionForPath(binPath);
  if (cacheVersion && cacheVersion !== MAESTRO_RUNNER_PIN.version) {
    let sha256: string | null = null;
    try {
      sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
    } catch {
      sha256 = null;
    }
    const expectedSha256 = (
      TRUSTED_DRIFT_SHA256 as Readonly<Record<string, Readonly<Partial<Record<string, string>>>>>
    )[cacheVersion]?.[platformKey];
    if (!sha256) {
      return buildReplayEngineStatus('unverified', null, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    const comparison = compareVersions(cacheVersion, MAESTRO_RUNNER_PIN.version);
    if (!expectedSha256) {
      return buildReplayEngineStatus('unverified', cacheVersion, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    if (sha256 !== expectedSha256) {
      return buildReplayEngineStatus('checksum-mismatch', null, false, {
        selectedPath: binPath,
        provenance: 'pin-cache',
      });
    }
    const cls = comparison < 0 ? 'drift-older' : comparison > 0 ? 'drift-newer' : 'unknown-version';
    return buildReplayEngineStatus(cls, cacheVersion, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  let sha256: string | null = null;
  try {
    sha256 = (resolvers.hashFile ?? defaultHashFile)(binPath);
  } catch {
    sha256 = null;
  }
  const expectedSha256 = MAESTRO_RUNNER_PIN.sha256[platformKey];
  if (!expectedSha256 || !sha256) {
    return buildReplayEngineStatus('unverified', null, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  if (sha256 !== expectedSha256) {
    return buildReplayEngineStatus('checksum-mismatch', null, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  if (!resolvers.binPath && !resolvers.hashFile && !installedPayloadMatchesPin(platformKey)) {
    return buildReplayEngineStatus('checksum-mismatch', null, false, {
      selectedPath: binPath,
      provenance: 'pin-cache',
    });
  }
  return buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
    selectedPath: binPath,
    provenance: 'pin-cache',
  });
}

export function getEngineStatus(resolvers?: EngineStatusResolvers): Promise<ReplayEngineStatus> {
  if (testStatus) return Promise.resolve(testStatus);
  return detect(resolvers ?? {}).catch(() =>
    buildReplayEngineStatus('unknown-version', null, false),
  );
}
