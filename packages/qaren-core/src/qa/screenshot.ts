import { currentInputs } from './inputs.js';
import { tryRawScreenshot } from '../handlers/device-screenshot-raw.js';
import { captureRunnerScreenshot } from '../runners/qaren-ios-runner-client.js';

export async function captureQaScreenshot(
  platform: 'ios' | 'android',
  path: string,
  deviceId: string | undefined,
  appId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (currentInputs()?.hasInputs) return { ok: false, reason: 'WITHHELD_PRIVATE_INPUT' };
  if (platform === 'ios') {
    if (!deviceId) return { ok: false, reason: 'TARGET_IDENTITY_UNAVAILABLE' };
    return (await captureRunnerScreenshot(deviceId, appId, path))
      ? { ok: true }
      : { ok: false, reason: 'RUNNER_SCREENSHOT_UNAVAILABLE' };
  }
  return tryRawScreenshot(platform, path, deviceId);
}
