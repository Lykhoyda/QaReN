export type RunnerPlatform = 'ios' | 'android';

export class RunnerArtifactMismatchError extends Error {
  constructor(version: string, platform: RunnerPlatform, detail: string) {
    super(`RUNNER_VERSION_MISMATCH: expected ${version} ${platform} runner; ${detail}`);
  }
}

export function isQarenRunnerRelease(version: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) && Number(version.split('.')[0]) >= 2;
}

export function assertRunnerAssetName(
  name: string,
  version: string,
  platform: RunnerPlatform,
): void {
  const expected =
    platform === 'ios'
      ? `qaren-ios-runner-${version}-sim.zip`
      : `qaren-android-runner-${version}.zip`;
  if (name !== expected) {
    throw new RunnerArtifactMismatchError(
      version,
      platform,
      `manifest names ${name}, expected ${expected}; use RN_RUNNER_BUILD=local on a source checkout until its runner release is published`,
    );
  }
}
