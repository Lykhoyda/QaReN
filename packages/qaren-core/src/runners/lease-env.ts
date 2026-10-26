export interface RunnerLease {
  sessionId: string;
  claimEpoch: number;
}

export const DEVICE_LEASE_REQUIRED =
  'DEVICE_LEASE_REQUIRED: native runner launch requires QAREN_DEVICE_LEASE from the qaren CLI';

const LEASE = /^[^:\s]+:[A-Za-z0-9_-]{16,}$/;

// The CLI hands its child QAREN_DEVICE_LEASE=<runId>:<token>; the native runners
// bind to that string as their session identity, so a second driver on the
// same device never adopts this run's runner.
export function leaseFromEnvironment(env: NodeJS.ProcessEnv = process.env): RunnerLease | null {
  const raw = env.QAREN_DEVICE_LEASE;
  if (!raw || !LEASE.test(raw)) return null;
  return { sessionId: raw, claimEpoch: 1 };
}
