// An Android runner build is the pair of main and instrumentation APK bytes.
// Package registration and version metadata do not establish build identity.
export interface AndroidRunnerBuildIdentity {
  appSha256: string;
  testSha256: string;
}

export type AndroidInstallAction = 'reuse' | 'install' | 'build-then-install';

export function resolveAndroidInstallAction(opts: {
  instrumentationRegistered: boolean;
  apksExist: boolean;
  expectedBuild?: AndroidRunnerBuildIdentity;
  installedBuild?: AndroidRunnerBuildIdentity;
}): AndroidInstallAction {
  const expected = opts.expectedBuild;
  const installed = opts.installedBuild;
  if (
    opts.instrumentationRegistered &&
    opts.apksExist &&
    expected &&
    installed &&
    /^[a-f0-9]{64}$/.test(expected.appSha256) &&
    /^[a-f0-9]{64}$/.test(expected.testSha256) &&
    installed.appSha256 === expected.appSha256 &&
    installed.testSha256 === expected.testSha256
  ) {
    return 'reuse';
  }
  return opts.apksExist ? 'install' : 'build-then-install';
}
