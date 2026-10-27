import {
  cancellableFetch,
  interruptible,
  isAbort,
  throwIfCancelled,
  withCancellation,
} from '../domain/cancellation.js';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { qarenHome } from '../util/secure-state-file.js';
import { dirname, join } from 'node:path';
import { candidateRunnerManifestFiles, firstExistingFile } from './runtime-paths.js';
import {
  assertRunnerAssetName,
  isQarenRunnerRelease,
  type RunnerPlatform,
} from '../domain/runner-artifact-identity.js';

export type { RunnerPlatform } from '../domain/runner-artifact-identity.js';
export type ArtifactProvenance = 'cache' | 'downloaded' | 'build-local';

export const RUNNER_REPO = 'Lykhoyda/QaReN';

const DOWNLOAD_TIMEOUT_MS = 60_000;
// The manifest records exact byte counts; a small slack absorbs boundary/overhead
// without allowing a surprise-sized asset through.
const DOWNLOAD_SIZE_SLACK_BYTES = 65_536;

export interface RunnerManifestAsset {
  name: string;
  sha256: string;
  bytes: number;
}

export interface RunnerManifest {
  version: string | null;
  xcodeBuildVersion?: string;
  assets: Record<RunnerPlatform, RunnerManifestAsset[]>;
}

export interface ResolvedIosArtifacts {
  provenance: ArtifactProvenance;
  derivedDataPath: string;
  note?: string;
}

export interface ResolvedAndroidArtifacts {
  provenance: ArtifactProvenance;
  appApk: string;
  testApk: string;
  note?: string;
}

// Injected IO surface so the resolver is unit-testable with fake fs + fetch.
export interface ArtifactDeps {
  env: Record<string, string | undefined>;
  readManifest(): RunnerManifest | null;
  cacheDir(version: string, platform: RunnerPlatform): string;
  existsSync(p: string): boolean;
  sha256File(p: string): string;
  listFiles(dir: string): string[];
  fetchToFile(
    url: string,
    dest: string,
    opts: { timeoutMs: number; maxBytes: number },
  ): Promise<void>;
  unzip(zipPath: string, destDir: string): void;
  mkdirp(p: string): void;
  rm(p: string): void;
}

// --- Pure helpers (no IO) ---

export function resolveArtifactDecision(input: {
  envOverride: boolean;
  hasManifestAssets: boolean;
  cacheValid: boolean;
}): 'cache' | 'download' | 'build-local' {
  if (input.envOverride) return 'build-local';
  if (!input.hasManifestAssets) return 'build-local';
  if (input.cacheValid) return 'cache';
  return 'download';
}

// Reject zip entries that would escape the extraction dir (path traversal /
// absolute paths / Windows drive or UNC roots).
export function assertNoTraversal(entryNames: string[]): void {
  for (const name of entryNames) {
    const norm = name.replace(/\\/g, '/');
    if (
      name.startsWith('/') ||
      name.startsWith('\\') ||
      /^[A-Za-z]:/.test(name) ||
      norm.split('/').includes('..')
    ) {
      throw new Error(`unsafe zip entry (path traversal): ${name}`);
    }
  }
}

export function verifyChecksums(
  expected: RunnerManifestAsset[],
  actualByName: Record<string, string>,
): { ok: boolean; mismatched: string[]; missing: string[] } {
  const mismatched: string[] = [];
  const missing: string[] = [];
  for (const a of expected) {
    const got = actualByName[a.name];
    if (got === undefined) missing.push(a.name);
    else if (got !== a.sha256) mismatched.push(a.name);
  }
  return { ok: mismatched.length === 0 && missing.length === 0, mismatched, missing };
}

export function releaseAssetUrl(repo: string, version: string, assetName: string): string {
  return `https://github.com/${repo}/releases/download/v${version}/${assetName}`;
}

export function cacheDirFor(
  qarenHomeDir: string,
  platformOS: string,
  version: string,
  platform: RunnerPlatform,
): string {
  void platformOS;
  return join(qarenHomeDir, 'runtime', 'runners', version, platform);
}

// Where xcodebuild writes XCTest result bundles for either runner root chosen by resolveIosRunnerArtifacts.
export function iosRunnerResultBundleDirs(
  version: string | null,
  localDerivedDataPath: string,
): string[] {
  const dirs = [join(localDerivedDataPath, 'Logs', 'Test')];
  if (version) {
    dirs.push(
      join(cacheDirFor(qarenHome(), process.platform, version, 'ios'), 'products', 'Logs', 'Test'),
    );
  }
  return dirs;
}

export function formatArtifactSize(bytes: number): string {
  return `~${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}

export function artifactProvenanceToState(p: ArtifactProvenance): 'prebuilt' | 'local' {
  return p === 'build-local' ? 'local' : 'prebuilt';
}

// --- Orchestration (uses injected deps) ---

// A released prebuilt is immutable per version, so one proven to lack required runner capabilities stays rejected.
const STALE_PREBUILT_MARKER = 'stale';

export function markPrebuiltRunnerStale(
  version: string,
  platform: RunnerPlatform,
  deps: ArtifactDeps = defaultArtifactDeps(),
): void {
  deps.mkdirp(join(deps.cacheDir(version, platform), STALE_PREBUILT_MARKER));
}

interface AcquireResult {
  provenance: ArtifactProvenance;
  productsDir?: string;
  note?: string;
}

async function acquireArtifact(
  platform: RunnerPlatform,
  version: string | null,
  deps: ArtifactDeps,
  extractedOk: (productsDir: string) => boolean,
): Promise<AcquireResult> {
  throwIfCancelled();
  if (deps.env.RN_RUNNER_BUILD === 'local') return { provenance: 'build-local' };

  if (!version || !isQarenRunnerRelease(version)) {
    return {
      provenance: 'build-local',
      note: `prebuilt runner refused: runtime version ${version ?? 'unknown'} does not identify a QaReN 2.x or newer release; legacy 1.x artifacts are excluded; building shipped source locally`,
    };
  }

  const manifest = deps.readManifest();
  if (!manifest) return { provenance: 'build-local' };
  if (manifest.version !== version) {
    return {
      provenance: 'build-local',
      note: `no published ${platform} runner for ${version} (manifest version is ${manifest.version}); building shipped source locally`,
    };
  }

  const assets = manifest.assets?.[platform] ?? [];
  if (assets.length === 0) return { provenance: 'build-local' };
  for (const asset of assets) assertRunnerAssetName(asset.name, version, platform);

  const cacheDir = deps.cacheDir(version, platform);
  if (deps.existsSync(join(cacheDir, STALE_PREBUILT_MARKER))) return { provenance: 'build-local' };
  const productsDir = join(cacheDir, 'products');

  // Cache is valid only when every zip is present with a matching SHA-256 AND the
  // extracted runner products are usable — re-hashed each time (artifacts are MBs).
  const actualByName: Record<string, string> = {};
  let allZipsPresent = true;
  for (const a of assets) {
    const zp = join(cacheDir, a.name);
    if (deps.existsSync(zp)) {
      try {
        actualByName[a.name] = deps.sha256File(zp);
      } catch {
        throwIfCancelled();
        allZipsPresent = false;
      }
    } else {
      allZipsPresent = false;
    }
  }
  const cacheValid =
    allZipsPresent && verifyChecksums(assets, actualByName).ok && extractedOk(productsDir);

  const decision = resolveArtifactDecision({
    envOverride: false,
    hasManifestAssets: true,
    cacheValid,
  });
  if (decision === 'cache') return { provenance: 'cache', productsDir };

  // decision === 'download' — verify BEFORE unzip, unzip with a traversal guard.
  throwIfCancelled();
  try {
    deps.mkdirp(cacheDir);
    for (const a of assets) {
      const zp = join(cacheDir, a.name);
      await interruptible(() =>
        deps.fetchToFile(releaseAssetUrl(RUNNER_REPO, version, a.name), zp, {
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          maxBytes: a.bytes + DOWNLOAD_SIZE_SLACK_BYTES,
        }),
      );
      const got = deps.sha256File(zp);
      if (got !== a.sha256) {
        throw new Error(`checksum mismatch for ${a.name} (expected ${a.sha256}, got ${got})`);
      }
      throwIfCancelled();
      deps.unzip(zp, productsDir);
    }
    throwIfCancelled();
    if (!extractedOk(productsDir)) {
      throw new Error('prebuilt archive missing expected runner products after unzip');
    }
    const totalBytes = assets.reduce((sum, a) => sum + a.bytes, 0);
    return {
      provenance: 'downloaded',
      productsDir,
      note: `downloaded prebuilt runner (${formatArtifactSize(totalBytes)})`,
    };
  } catch (err) {
    try {
      withCancellation(undefined, () => deps.rm(productsDir));
    } catch {
      /* best-effort cleanup of a partial extract */
    }
    throwIfCancelled();
    if (isAbort(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      provenance: 'build-local',
      note: `prebuilt runner unavailable (${msg}); building locally`,
    };
  }
}

function iosExtractedOk(deps: ArtifactDeps): (productsDir: string) => boolean {
  return (productsDir) =>
    deps.listFiles(join(productsDir, 'Build', 'Products')).some((f) => f.endsWith('.xctestrun'));
}

export async function resolveIosRunnerArtifacts(
  version: string | null,
  localDerivedDataPath: string,
  deps: ArtifactDeps = defaultArtifactDeps(),
  forceLocalBuild = false,
): Promise<ResolvedIosArtifacts> {
  throwIfCancelled();
  if (forceLocalBuild) {
    return { provenance: 'build-local', derivedDataPath: localDerivedDataPath };
  }
  const r = await acquireArtifact('ios', version, deps, iosExtractedOk(deps));
  throwIfCancelled();
  const derivedDataPath = r.provenance === 'build-local' ? localDerivedDataPath : r.productsDir!;
  return { provenance: r.provenance, derivedDataPath, note: r.note };
}

// No published runner is compatible with this version: Android always builds the shipped source.
export function resolveAndroidRunnerArtifacts(local: {
  appApk: string;
  testApk: string;
}): ResolvedAndroidArtifacts {
  return { provenance: 'build-local', ...local };
}

// --- Production IO ports ---

function readCommittedManifest(): RunnerManifest | null {
  try {
    const manifestPath = firstExistingFile(candidateRunnerManifestFiles());
    if (!manifestPath) return null;
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as RunnerManifest;
    if (parsed && typeof parsed === 'object' && parsed.assets) return parsed;
    return null;
  } catch {
    return null;
  }
}

function sha256File(p: string): string {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

async function fetchToFile(
  url: string,
  dest: string,
  opts: { timeoutMs: number; maxBytes: number },
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('artifact download timed out')),
    opts.timeoutMs,
  );
  try {
    const res = await cancellableFetch(fetch, url, {
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
    if (!res.body) throw new Error(`empty response body for ${url}`);
    throwIfCancelled();
    mkdirSync(dirname(dest), { recursive: true });
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await interruptible(() => reader.read(), controller.signal);
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        throw new Error(`artifact exceeds size cap (${opts.maxBytes} bytes)`);
      }
      chunks.push(Buffer.from(value));
    }
    throwIfCancelled(controller.signal);
    writeFileSync(dest, Buffer.concat(chunks));
  } finally {
    clearTimeout(timer);
  }
}

function unzipWithGuard(zipPath: string, destDir: string): void {
  throwIfCancelled();
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf-8' });
  const entries = listing
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  assertNoTraversal(entries);
  throwIfCancelled();
  mkdirSync(destDir, { recursive: true });
  execFileSync('unzip', ['-o', '-qq', zipPath, '-d', destDir], { stdio: 'ignore' });
}

export function defaultArtifactDeps(): ArtifactDeps {
  return {
    env: process.env,
    readManifest: readCommittedManifest,
    cacheDir: (version, platform) => cacheDirFor(qarenHome(), process.platform, version, platform),
    existsSync,
    sha256File,
    listFiles: (dir) => {
      try {
        return readdirSync(dir);
      } catch {
        return [];
      }
    },
    fetchToFile,
    unzip: unzipWithGuard,
    mkdirp: (p) => {
      mkdirSync(p, { recursive: true });
    },
    rm: (p) => {
      rmSync(p, { recursive: true, force: true });
    },
  };
}
