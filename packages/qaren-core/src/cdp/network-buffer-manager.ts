import { DeviceBufferManager } from '../ring-buffer.js';
import type { NetworkEntry } from '../types.js';

/**
 * B128 (D657): process-scoped DeviceBufferManager for network events.
 *
 * Before this fix, the manager was instantiated inside CDPClient, so every
 * `cdp_connect(force: true)` / `cdp_restart` (which destroys and rebuilds
 * the CDPClient to switch target) wiped ALL per-device buffers — including
 * the ones for devices the user wasn't even switching away from.
 *
 * By hoisting the manager to module scope, it now survives CDPClient
 * lifecycle events. Per-device isolation (D655) is preserved: events land
 * in buckets keyed on `${metroPort}-${targetId}` regardless of which
 * CDPClient instance processed them. Switching iOS → Android → iOS now
 * sees the original iOS buffer intact, satisfying the original M4 design
 * intent "active devices retain history even if idle."
 *
 * Memory bound unchanged: capacityPerDevice × maxDevices = 100 × 10 = 1000
 * entries total across all devices. Oldest-by-last-push eviction still
 * applies when the 10-device cap is hit.
 *
 * Lifetime: singleton per MCP process. Cleared only on full MCP restart
 * (process exit) or explicit `resetNetworkBufferManager()` call (test-only).
 */

let manager: DeviceBufferManager<NetworkEntry, string> | null = null;

export function getNetworkBufferManager(): DeviceBufferManager<NetworkEntry, string> {
  if (!manager) {
    manager = new DeviceBufferManager<NetworkEntry, string>({
      capacityPerDevice: 100,
      maxDevices: 10,
      indexKey: (e) => e.id,
      timestampOf: (e) => new Date(e.timestamp).getTime(),
    });
  }
  return manager;
}

/**
 * Test-only reset. Production code must NOT call this — it would defeat the
 * persistence guarantee the module exists to provide. Used in unit tests to
 * establish a clean baseline between test cases.
 */
export function resetNetworkBufferManager(): void {
  manager = null;
}
